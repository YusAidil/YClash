const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMPORTED_UPGRADES = 10;
const TIMER_PATTERN = /(\d{1,3})\s*(days?|d|hours?|hrs?|h|jam|j|minutes?|mins?|menit|m|seconds?|secs?|detik|s)\b/gi;
let workerPromise;
let recognitionQueue = Promise.resolve();

function parseRemainingDuration(line) {
  const matches = [...line.matchAll(TIMER_PATTERN)];
  if (!matches.length) return 0;
  const usesIndonesianUnits = matches.some(match => /^(hari|jam|j|menit|detik)$/i.test(match[2]));
  return matches.reduce((total, match) => {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (/^(d|day)/.test(unit) || (unit === 'h' && usesIndonesianUnits)) return total + amount * 86400000;
    if (/^(h|hr|hour|j|jam)/.test(unit)) return total + amount * 3600000;
    if (/^(m|min|menit)/.test(unit)) return total + amount * 60000;
    if (/^(s|sec|detik)/.test(unit)) return total + amount * 1000;
    return total;
  }, 0);
}

function normalizeOcrRow(text) {
  return String(text)
    .replace(/\b1\s*1a[j]\b/gi, '14j')
    .replace(/\b1a[j]\b/gi, '14j')
    .replace(/\baj\b/gi, '4j')
    .replace(/\ba[o0]?m\b/gi, '40m')
    .replace(/\b(?:h[fla]|i[hf])\b/gi, '1h');
}

function getEditDistance(first, second) {
  const previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
    let previousDiagonal = previousRow[0];
    previousRow[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
      const previousCell = previousRow[secondIndex];
      previousRow[secondIndex] = Math.min(
        previousRow[secondIndex] + 1,
        previousRow[secondIndex - 1] + 1,
        previousDiagonal + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
      );
      previousDiagonal = previousCell;
    }
  }
  return previousRow[second.length];
}

function normalizeKnownHeroName(value) {
  const heroes = ['Adipati Naga', 'Jawara Royale', 'Raja Barbar', 'Ratu Pemanah', 'Wali Besar'];
  const normalized = value.toLocaleLowerCase('id-ID').replace(/[^\p{L}]/gu, '');
  let closestHero = value;
  let closestScore = 0;
  for (const hero of heroes) {
    const candidate = hero.toLocaleLowerCase('id-ID').replace(/[^\p{L}]/gu, '');
    const score = 1 - getEditDistance(normalized, candidate) / Math.max(normalized.length, candidate.length);
    if (score > closestScore) {
      closestHero = hero;
      closestScore = score;
    }
  }
  return closestScore >= 0.62 ? closestHero : value;
}

function cleanUpgradeName(line) {
  return line
    .replace(TIMER_PATTERN, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseActiveUpgradesText(text) {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const sectionStart = lines.findIndex(line => /bangunan|pahlawan|building|hero/i.test(line));
  const suggestionStart = lines.findIndex(line => /saran\s+peningkatan|suggested\s+upgrades?/i.test(line));
  const start = sectionStart >= 0 ? sectionStart + 1 : 0;
  const end = suggestionStart >= start ? suggestionStart : Math.min(lines.length, start + 12);
  const activeLines = lines.slice(start, end);
  const candidates = [];

  for (let index = 0; index < activeLines.length && candidates.length < MAX_IMPORTED_UPGRADES; index++) {
    let line = activeLines[index];
    if (!TIMER_PATTERN.test(line)) {
      TIMER_PATTERN.lastIndex = 0;
      if (index + 1 >= activeLines.length || !TIMER_PATTERN.test(activeLines[index + 1])) continue;
      TIMER_PATTERN.lastIndex = 0;
      line = `${line} ${activeLines[index + 1]}`;
      index++;
    } else {
      TIMER_PATTERN.lastIndex = 0;
    }

    const remainingMs = parseRemainingDuration(line);
    const building = cleanUpgradeName(line);
    if (!remainingMs || !building || /^(tersedia|saran|peningkatan|upgrade|building|hero)$/i.test(building)) continue;
    candidates.push({ building: building.slice(0, 48), remainingMs });
  }

  return candidates;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng+ind').catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function recognizeLandscapeRows(imageBuffer, metadata, worker) {
  const left = Math.round(metadata.width * 0.692);
  const width = Math.min(metadata.width - left, Math.round(metadata.width * 0.274));
  const firstRowTop = Math.round(metadata.height * 0.094);
  const rowHeight = Math.round(metadata.height * 0.067);
  const candidates = [];

  await worker.setParameters({ tessedit_pageseg_mode: '7', user_defined_dpi: '300' });
  try {
    for (let index = 0; index < MAX_IMPORTED_UPGRADES; index++) {
      const top = firstRowTop + index * rowHeight;
      if (top + rowHeight > metadata.height) break;

      const row = sharp(imageBuffer, { limitInputPixels: MAX_IMAGE_PIXELS })
        .extract({ left, top, width, height: rowHeight });
      const [thresholdImage, rawImage] = await Promise.all([
        row.clone().resize({ width: width * 2 }).greyscale().threshold(190).negate().png().toBuffer(),
        row.greyscale().png().toBuffer()
      ]);
      const [thresholdResult, rawResult] = await Promise.all([
        worker.recognize(thresholdImage),
        worker.recognize(rawImage)
      ]);
      const thresholdText = thresholdResult.data.text.trim();
      const rawText = rawResult.data.text.trim();
      if (/saran|peningkatan|suggested|upgrade/i.test(`${thresholdText} ${rawText}`)) break;

      const buildingText = normalizeOcrRow(thresholdText || rawText);
      const timerText = normalizeOcrRow(rawResult.data.confidence > thresholdResult.data.confidence ? rawText : thresholdText);
      const remainingMs = parseRemainingDuration(timerText) || parseRemainingDuration(buildingText);
      const building = normalizeKnownHeroName(cleanUpgradeName(buildingText)).slice(0, 48);
      if (!building || !remainingMs) continue;
      candidates.push({ building, remainingMs });
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '' });
  }

  return candidates;
}

async function recognizeActiveUpgrades(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length || imageBuffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Foto harus berukuran maksimal 8 MB.');
  }

  let metadata;
  try { metadata = await sharp(imageBuffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); }
  catch { throw new Error('Foto tidak dapat dibaca. Unggah file PNG, JPG, atau WebP yang valid.'); }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new Error('Format foto harus PNG, JPG, atau WebP dengan resolusi yang wajar.');
  }

  const landscape = metadata.width / metadata.height >= 1.25;
  const left = landscape ? Math.floor(metadata.width * 0.62) : 0;
  const top = 0;
  const width = metadata.width - left;
  const height = landscape ? Math.floor(metadata.height * 0.42) : metadata.height;
  let image;
  try {
    image = await sharp(imageBuffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .extract({ left, top, width, height })
      .resize({ width: Math.min(1600, width * 2) })
      .greyscale()
      .normalize()
      .png()
      .toBuffer();
  } catch {
    throw new Error('Foto tidak dapat dibaca. Unggah file PNG, JPG, atau WebP yang valid.');
  }

  const runRecognition = async () => {
    const worker = await getWorker();
    const result = await worker.recognize(image);
    let upgrades = parseActiveUpgradesText(result.data.text);
    if (landscape && upgrades.length < 3) {
      const rowUpgrades = await recognizeLandscapeRows(imageBuffer, metadata, worker);
      if (rowUpgrades.length > upgrades.length) upgrades = rowUpgrades;
    }
    if (!upgrades.length) throw new Error('Timer aktif tidak terbaca. Unggah foto panel Bangunan dan Pahlawan yang lebih jelas.');
    return upgrades;
  };

  const result = recognitionQueue.then(runRecognition, runRecognition);
  recognitionQueue = result.catch(() => {});
  return result;
}

module.exports = {
  MAX_IMPORTED_UPGRADES,
  MAX_SCREENSHOT_BYTES,
  parseActiveUpgradesText,
  recognizeActiveUpgrades
};
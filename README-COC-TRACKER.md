# YClash

Tracker Clash of Clans dengan akun pengguna terpisah, timer upgrade dan potion privat, jadwal event, serta notifikasi Discord bersama.

## Potion dan event

Timer mendukung Builder, Clock Tower, Hero, Pet, Power, Research, Resource, Training, dan Super Potion dengan durasi efek bawaan game. Jumlah potion dapat ditambahkan sekaligus; durasi timer bertambah sesuai jenis potion. Builder Potion diterapkan ke semua upgrade aktif, dengan kecepatan 10× selama jumlah jam yang ditambahkan.

Saat membuat timer upgrade, masukkan durasi yang benar-benar ditampilkan di game, termasuk potongan event yang sudah berlaku. Builder Potion dikelola terpisah di menu Potion; saat digunakan, efeknya diterapkan ke semua upgrade aktif, jadi pengguna tidak perlu membuat ulang daftar upgrade. Setiap Builder Potion menambah satu jam efek 10× pada timer potion.

Satu login YClash dapat memiliki hingga 10 profil desa CoC. Tambahkan, pilih, ganti nama, atau hapus profil dari pengaturan akun; setiap profil memiliki jumlah builder, upgrade, potion, dan riwayat sendiri. Data tracker lama otomatis dipindahkan ke profil `Desa Utama`. Profil terakhir tidak dapat dihapus.

### Review akun berdasarkan tag

Pengguna yang masuk dapat menyimpan satu player tag di setiap profil desa dan memuat profil publik, progres level hero/troop/spell/equipment, trophy, liga, dan klan. Data bangunan, wall, serta trap tidak disediakan oleh API resmi. Profil akun disegarkan saat diminta dan hasil API publik di-cache selama lima menit.

Untuk mengaktifkan fitur, buat token API di [Supercell Developer Portal](https://developer.clashofclans.com/) dan izinkan IP publik server pada pengaturan token. Simpan token sebagai `COC_API_TOKEN` di environment server atau `.env` lokal. Jangan pernah menaruh token di HTML atau membagikannya. Tanpa token yang valid, fitur review menampilkan status belum dikonfigurasi.

Jadwal event saat ini dikurasi dari artikel resmi Supercell untuk November 2026 dan event yang berakhir otomatis disembunyikan. Supercell belum menyediakan kalender event terstruktur untuk aplikasi ini, jadi daftar perlu diperbarui dari artikel bulanan terbaru.

## Menjalankan di komputer

1. Pasang Node.js versi LTS.
2. Salin `.env.example` menjadi `.env`.
3. Atur `ADMIN_PASSWORD` sepanjang 20-128 huruf/angka di `.env`. Password ini dipakai untuk login panel admin di `/admin` dan untuk migrasi data tracker lama. Untuk mengaktifkan review tag, isi `COC_API_TOKEN` dengan token dari Supercell Developer Portal setelah menambahkan IP server ke allowlist. Jangan unggah atau kirim isi `.env`.
4. Di PowerShell, dari folder proyek jalankan:

   ```powershell
   npm install
   npm start
   ```

5. Buka `http://localhost:3000`, lalu buat akun atau masuk. Setiap akun memiliki timer dan riwayat sendiri.

Pada upgrade dari versi lama, data `data/upgrades.json` dipindahkan sekali ke akun `owner`. Password akun itu diambil dari `ADMIN_PASSWORD` yang sudah ada.

## Panel admin

Buka `/admin` dan masuk menggunakan `ADMIN_PASSWORD`. Panel menampilkan daftar akun, jumlah desa, ringkasan timer, dan detail upgrade, potion, serta riwayat yang dikelompokkan per desa. Admin dapat menonaktifkan atau mengaktifkan kembali akun, atau menghapus akun beserta seluruh datanya. Sesi pengguna dicabut saat akun dinonaktifkan. Akun `owner` utama dilindungi dari penonaktifan dan penghapusan. Password serta hash akun tidak ditampilkan.

## Menghubungkan Discord

1. Buat aplikasi dan bot di [Discord Developer Portal](https://discord.com/developers/applications).
2. Undang bot ke server Discord dengan scope `bot` dan `applications.commands`, serta izin **Send Messages** pada channel notifikasi.
3. Salin token bot ke `DISCORD_BOT_TOKEN` dan ID channel tujuan ke `DISCORD_CHANNEL_ID` di `.env`.
4. Matikan lalu jalankan ulang `npm start`. Bot mendaftarkan slash command `/yclash-link` pada server yang sama dengan channel notifikasi.
5. Masuk ke YClash, klik **Hubungkan**, lalu jalankan `/yclash-link` di server Discord dengan kode yang tampil. Kode berlaku 10 menit; satu akun Discord hanya dapat ditautkan ke satu akun YClash. Tautan dapat diputuskan dari dashboard. Setelah ditautkan, nama tampilan dan avatar Discord muncul di profil YClash Player bersama handle Discord dan username YClash.
6. Notifikasi selesai dikirim ke channel bersama, menyertakan username YClash, dan hanya melakukan mention kepada akun Discord yang sudah ditautkan. Jangan masukkan token bot ke HTML, unggah ke GitHub, atau kirim lewat chat.

Bot tidak perlu intents anggota atau pesan. Bot hanya mengirim pesan ketika timer selesai.

Untuk mengubah konfigurasi Discord, atur `DISCORD_BOT_TOKEN` dan `DISCORD_CHANNEL_ID` melalui environment pada host. Jangan menyimpan token di source code atau mengunggah file `.env`.

## Membuatnya online

Deploy proyek sebagai aplikasi Node.js pada host yang tetap berjalan. Atur build/install command `npm install` dan start command `npm start`. Masukkan `ADMIN_PASSWORD`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, dan `COC_API_TOKEN` melalui pengaturan environment variables di host, bukan di source code. Tambahkan IP publik host ke allowlist token API CoC.

Pasang persistent disk/volume pada folder `data` di dalam proyek. Aplikasi menyimpan akun ke `data/accounts.json` dan timer upgrade serta potion per akun ke `data/user-states.json`; `data/upgrades.json` hanya dipakai untuk migrasi dari versi lama. Penyimpanan filesystem sementara dapat menghapus data saat restart atau redeploy. Pilih layanan yang tidak menidurkan aplikasi agar bot tetap terhubung dan pengingat berjalan 24 jam. Setelah deploy, pengguna dapat mendaftar untuk tracker pribadi.

Jika bot gagal mengirim pesan, pastikan bot masih berada di server dan memiliki izin **View Channel** serta **Send Messages** di channel tujuan.

## Deploy ke Oracle Cloud VM

**Periksa biaya dulu:** tangkapan layar menunjukkan trial sudah berakhir dan VM `VM.Standard.E5.Flex`. Pastikan VM yang dipilih memang memenuhi Always Free atau kamu siap dengan biayanya. Jangan mengandalkan VM trial sebelum status billing dan datanya aman.

1. Pastikan VM berstatus **Running**, catat IP publiknya, dan siapkan domain dengan DNS A record yang mengarah ke IP tersebut. Di Oracle Linux, nama SSH biasanya `opc`; di Ubuntu biasanya `ubuntu`.
2. Dari PowerShell di folder `PROGRAMKU`, unggah folder aplikasi menggunakan SSH key milikmu:

   ```powershell
   scp -i C:\path\ke\ssh-key.pem -r .\coc-tracker opc@IP_PUBLIK:/home/opc/
   ssh -i C:\path\ke\ssh-key.pem opc@IP_PUBLIK
   ```

   Ganti `opc` menjadi `ubuntu` jika VM memakai Ubuntu. Jangan pernah mengirim file SSH key ke chat.
3. Pasang Node.js 18 atau lebih baru sesuai sistem operasi VM, lalu di sesi SSH jalankan:

   ```sh
   cd ~/coc-tracker
   npm ci
   ```

   Atur `ADMIN_PASSWORD` dan token opsional langsung di file `.env` pada VM atau melalui environment variables service. Batasi akses `.env` ke pemilik service (`chmod 600 .env`) dan jangan unggahnya ke repo.
4. Di Oracle Security List/NSG, tambahkan ingress TCP 80 dari `0.0.0.0/0` untuk penerbitan sertifikat dan TCP 443 untuk HTTPS. Arahkan DNS domain milikmu ke IP VM.
5. Salin `coc-tracker.service` ke `/etc/systemd/system/coc-tracker.service` dan `nginx-coc-tracker.conf` ke `/etc/nginx/sites-available/coc-tracker`. Aktifkan konfigurasi Nginx dengan symlink ke `sites-enabled`, lalu jalankan `sudo nginx -t` dan `sudo systemctl reload nginx`.
6. Ganti `server_name` di konfigurasi Nginx dengan domain milikmu, lalu terbitkan sertifikat dan paksa redirect ke HTTPS: `sudo certbot --nginx -d DOMAIN_MILIKMU --redirect`. Setelah berhasil, aktifkan aplikasi: `sudo systemctl enable --now coc-tracker`.
7. Buka domain HTTPS milikmu. Pengguna bisa mendaftar untuk mengelola timer privat mereka sendiri. Pantau log dengan `sudo journalctl -u coc-tracker -f`.

Instance YClash saat ini menggunakan `yclash.duckdns.org`. Konfigurasi awal Nginx-nya tersedia di [nginx-yclash-duckdns.conf](nginx-yclash-duckdns.conf); setelah mengaktifkannya, jalankan `sudo certbot --nginx -d yclash.duckdns.org --redirect` untuk memasang HTTPS dan redirect.

Simpan `data/upgrades.json` pada disk VM yang persisten dan backup secara berkala. Jangan meletakkan token Discord atau password admin di repo publik. Password yang dibuat dengan helper harus 20-128 karakter, huruf dan angka saja.
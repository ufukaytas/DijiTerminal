# Değişiklik Günlüğü

Bu dosya [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) düzenini, sürümler [SemVer](https://semver.org/lang/tr/) kuralını izler.
Sürümün tek kaynağı `package.json`; `.dmg` adı ve Hakkında penceresi oradan okunur.

## [Yayımlanmadı]

### Eklendi
- **Session'ı kapat:** detay panelinde ve terminal çubuğunda. Çalışan arka plan session'ı `claude stop` ile durdurulur; bitmiş ya da uyuyan session yalnızca haritadan kaldırılır (uygulama hatırlar). Konuşma silinmez, `claude attach <id>` ile dönülebilir; session yeniden çalışırsa haritaya geri gelir. İki adımlı onay.
- **Geçmiş:** üst bardaki saat ikonu haritada olmayan arka plan session'larını listeler (kapatılan, durdurulan, başarısız, 24 saatten eski); ada, klasöre ya da kimliğe göre aranır. "Aktif et" session'ı haritaya geri getirir ve gömülü terminalde açar; "Kopyala" `claude attach <id>` komutunu kopyalar.

## [0.2.0] - 2026-10-29

Robot ekipleri, menü çubuğu modu ve gömülü terminal.

### Eklendi
- **Gömülü terminal (07/01):** arka plan session'ları (`claude --bg`, `/bg`) uygulamanın altındaki sekmeli terminal panelinde açılır — `claude attach` ile aynı session, renk ve klavyesiyle. Detay panelinde "Uygulamada aç", haritada çift tık, menü çubuğu listesinden seçme; üst barda "+ Yeni oturum" (proje seç, isteğe bağlı ilk görev → `claude --bg`). Sekmeyi kapatmak session'ı durdurmaz; session başka bir terminalde açılırsa sekme "Buraya geri al" der. Terminal menüsü: ⌘J panel, ⇧⌘[ / ⇧⌘] sekme, ⇧⌘W sekmeyi kapat. Terminal alttaki panel ya da haritanın üstünde pencere (modal) olarak açılabilir; ⇧⌘J ya da paneldeki düğmeyle geçilir, seçim hatırlanır. Pencere çubuğundan sürüklenip taşınır, kenar ve köşelerden boyutlandırılır (konum/boyut hatırlanır; çubuğa çift tıklama ortalar). Ayarlar › Gömülü terminal: aç/kapat, claude yolu, yazı boyutu. Etkileşimli iTerm2 session'ları eskisi gibi iTerm2'de açılır.
- Robotlar boştayken (ve işi bitince) pedlerine oturur, iş gelince ayağa kalkar.
- **Robot ekipleri (03/08):** 3B haritada her session bir robot ekibi — ortada büyük lider robot, etrafında kendi pedlerinde alt ajan robotları. Robotlar iki tonlu "chibi" tasarımda: beyaz kabuk, aksan rengi takım/tip (liderde proje rengi); göz, göğüs ışığı ve ped durumu, ağız ruh hâlini gösterir. Robotlar yazar, onay isterken el kaldırır, alt ajanları beklerken tarar, boştayken uyur; yeni alt ajan liderin pedinden yürüyerek gelir. Hover'da ipucu kartı (araç, süre, maliyet, ctx), tıklayınca Seçili Session'da ajanın satırı vurgulanır, çift tık terminal sekmesine gider. Workers kartlarında robot renk noktası.
- **Web küresi (03/08):** düz web halkasının yerine panonun web yeşilinde noktalı dünya (karalar, kenar parıltısı, süzülen ağ); her süren WebSearch/WebFetch sorgu ya da alan adı etiketli bir uydu, varan istek yüzeyde dalga. Altındaki "WEB · N istek/dk · M açık" rozeti kamerayı küreye yaklaştırır. Kara verisi: Natural Earth (kamu malı).
- **Menü çubuğu modu (06/01):** menü çubuğunda durum ikonu (boşta / çalışıyor / bekliyor; açık ve koyu menü çubuğuna uyan template image) ve yanında bekleyen sayısı. Tıklayınca açılan listede bekleyenler üstte; satır → iTerm2 sekmesi, ⌖ → haritada göster; altta kullanım limitleri, "Panoyu aç", "Ayarlar", "Çıkış". Sağ tık menüsü. Ayarlar › Menü çubuğu: menü çubuğunda göster, Dock ikonunu gizle.

### Değişti
- 3B haritada anten ve ajan küreleri robot ekipleriyle değişti; session odağında kamera biraz daha geniş açıdan bakar.
- 3B haritanın "Tümü" görünümü bütün sahneyi (web küresi + platformlar) her pencere oranında kadraja sığdırır; tam ekranda küre üstten kesilmez.
- Terminal kapanınca session hemen "sona erdi" olur ve 3B haritadan (ve 2B listeden) kalkar; yaşayan session'ı kalmayan projenin platformu da kalkar. Sona erenler session.log ve Seçili Session panelinde 30 dk görünmeye devam eder.
- Dock rozeti ve menü çubuğu bekleyen sayısını tek yerden alır; motor, pano ya da menü çubuğu listesi görünürken canlı tempoda çalışır.

### Güncelleme notu
- Kaynaktan derlerken `npm install` gerekir (yeni bağımlılıklar: node-pty, xterm.js). node-pty'nin Mac için hazır derlenmiş dosyaları pakette gelir; Xcode gerekmez.
- Gömülü terminal için `claude` CLI'nin `claude agents --json` desteği gerekir (Claude Code 2.1.312'de doğrulandı). Yol otomatik bulunur; bulunamazsa Ayarlar › Gömülü terminal.

### Bilinen sorunlar
- Aktif kullanımda toplam RSS (main + renderer + GPU) 350 MB bütçesinin üstünde (M3 Pro'da p95 ≈ 450–460 MB, terminal açık ya da kapalı aynı). Ölçüm macOS footprint'ine taşınıp bütçe yeniden değerlendirilecek (05/02).
- Aynı arka plan session'ına iTerm2'den de bağlanılırsa ekran son bağlananın boyutunda çizilir; uygulamadaki terminale tıklamak yeniden çizer.

## [0.1.0] - 2026-10-28

İlk kullanılabilir sürüm (MVP).

### Eklendi
- **Faz 1 — uygulamasız:** iTerm2 sekmelerini session durumuna göre boyayan hook'lar, onay beklerken bildirim, `statusLine` ile kullanım limitleri; `npm run hooks:install` kurulum aracı (yedekli, geri alınabilir).
- **Motor:** `~/.claude` registry ve transcript'lerini salt okunur izleme; alt ajan takibi, proje çözümleme (git kökü, worktree, takım önekleri), durum kuralları (yavaş araç, %80 context, döngü şüphesi, aynı dosyada çakışma), bugünkü maliyet; hook olaylarıyla düşük gecikmeli durum geçişi.
- **Arayüz:** üst bar (sayaçlar, proje filtresi, "Bekleyene git"), Seçili Session paneli, Workers paneli, filtrelenebilir session.log, 3B proje haritası (platform, amblem, anten, ajan küreleri, canlı parçacık efektleri) ve 2B liste yedeği.
- **macOS:** tıklayınca iTerm2/Terminal sekmesine odaklanma (Otomasyon izni), uygulama bildirimleri ve Dock rozeti, tek örnek kilidi, ayarlar paneli (⌘,).
- **Paketleme:** arm64 ve x64 `.dmg`, ad-hoc imza, uygulama ikonu, girişte başlatma seçeneği.
- **Kalite:** sentetik fixture'lar ve replay, performans bütçesi ve `npm run bench`.
- **Görüntü kalitesi ayarı:** Yüksek / Dengeli (Dengeli, Retina'da haritayı 1.5 piksel oranıyla çizer; GPU daha az çalışır).

### Değişti
- 3B harita tek çizim döngüsüyle çalışır: aktifken ≈60 fps, yalnızca yavaş nabızlar varken 15 fps, boşta 4 fps; pencere gizliyken durur.
- Büyük `~/.claude` klasörlerinde açılış hızlandı (500 MB sentetik veride 1.5 → 0.85 sn); gizli pencerede motor taramaları seyrekleşir, pencereye snapshot/olay gönderilmez.
- 3B harita ayrı yüklenir: ilk açılışta yüklenen kod 1.3 MB → 356 KB.

### Düzeltildi
- Saatler önce bitmiş arka plan ajanları açılışta "az önce bitti" görünmez.
- Session adı Claude Code'un otomatik adı yerine konu başlığını gösterir; alt ajan log satırları açılış anı yerine kayıt zamanını alır.
- Electron 45'in kurulumda ikili dosyayı indirmemesi (`postinstall`), macOS'ta `procStart` biçimi, GPU'da kalan ızgara geometrisi.

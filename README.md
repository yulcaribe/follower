# Follower

Chrome eklentisiyle **açık Instagram oturumundaki takipçi ve takip edilenleri** manuel tara; sonuçları **tek Go sunucusunda JSON olarak** sakla. Mobil uyumlu web panelinden admin şifresiyle giriş yaparak bütün Instagram hesaplarını ve geçmişlerini görüntüle.

## Nasıl çalışır?

- **Instagram hesabı:** Chrome'da Instagram'a normal giriş yap. Eklenti bu oturumla takipçi / takip edilen listesini okur; Instagram parolasını ve çerezlerini Follower sunucusuna göndermez.
- **Birden fazla hesap:** Tarama verileri **Instagram'ın sayısal kullanıcı ID'sine** göre `accounts/<id>/` altında ayrı saklanır; kullanıcı adı arayüzde gösterilir. Farklı bir Instagram hesabına geçip taradığında yeni kayıt oluşur. Kullanıcı adı değişse bile geçmiş aynı kullanıcı ID'sine bağlı kalır.
- **Tek admin girişi:** Follower panelinde admin şifrenle oturum açman yeterlidir. **İkinci erişim anahtarı, API tokenı veya eklenti hesabı yok.** Eklenti taradığı verileri açık ve admin girişi yapılmış Follower sekmesinin oturumu üzerinden kaydeder.
- **Merkezi veri:** Her şey Go sunucusundaki JSON geçmişinde kalır. İkinci bilgisayarda panele admin şifresiyle girince hesap listeleri ve sonuçlar aynıdır.
- **Elle tarama:** Tarama yalnızca eklentideki düğmeye basıldığında çalışır. Otomatik tarama, arka plan işi yok.
- **Minimal sunucu:** Standart kütüphaneli Go + JSON + systemd, varsayılan **3101** portu. Node.js, Playwright, Chromium, Lightpanda, Docker veya SQLite **sunucuda gerekmez**.

## Sunucu kurulumu

Ubuntu/Debian ve root ile:

```bash
curl -fsSL https://raw.githubusercontent.com/yulcaribe/follower/main/install.sh | bash
```

Web paneli: `http://SUNUCU_IP:3101`.

İlk açılışta web paneli **Yeni admin şifresi / Şifre tekrar** ekranını gösterir. Kullanıcı adı, kurulum kodu veya otomatik oluşturulan şifre yoktur. İlk kaydı yapan kişi yönetici olur; bu yüzden panel internete açıksa başkası senden önce şifre oluşturabilir. Daha sonra yalnızca admin şifresi gerekir. Güncelleme mevcut `admin.json` ve bütün hesapların JSON geçmişini korur; başarısızsa önceki Go sürümüne geri döner.

**Kurucu başka yazılım kaldırmaz:** Eski Playwright, Chromium, Node.js veya follower-browser servisi varsa bunlara dokunmaz; elle temizlenmeleri ayrı işlemdir. Başka port, uygulama ve güvenlik duvarı ayarları da korunur.

## Chrome eklentisi

1. GitHub'daki `extension/` klasörünü indir.
2. Chrome > `chrome://extensions` > **Geliştirici modu** > **Paketlenmemiş öğe yükle** > `extension/` klasörünü seç.
3. Eklentide **Follower sunucu adresini** (`http://SUNUCU_IP:3101`) bir defa kaydet; Chrome'un bu siteye erişim iznini ver. **Şifre veya ikinci anahtar yazılmaz.**
4. **Admin paneli** düğmesiyle Follower'ı aç, admin şifresiyle giriş yap ve panel sekmesini açık tut.
5. Chrome'da `instagram.com` sitesine giriş yap. Eklentiden **Bu Instagram hesabını tara** düğmesine bas. Kullanıcı adı Instagram sayfasındaki profil bağlantısından okunamazsa, eklentideki isteğe bağlı kullanıcı adı alanına kendi hesabının adını gir. Tarama öncesinde `/api/v1/users/{id}/info/` isteği artık yapılmaz.
6. İki liste tamamlanınca tarama, admin oturumu açık Follower panelinin aynı-origin `/api/scan` uç noktasından JSON olarak kaydedilir.
7. Başka Instagram hesabını taramak için Instagram'da hesaba geç ve aynı düğmeye bas. Web panelindeki hesap listesinden istediğinin geçmişini seç.

İkinci bilgisayardan sonuçları **görmek** için Follower paneline admin girişi yeterlidir. Yeni tarama yapacaksan o bilgisayarda da eklenti ve Instagram oturumu gerekir.

## Veri saklama

```text
/opt/follower/data/admin.json
/opt/follower/data/accounts/<instagram-kullanıcı-id>/profile.json
/opt/follower/data/accounts/<instagram-kullanıcı-id>/snapshots/*.json
```

Her taramada `profile.json` kullanıcı adını günceller; eski snapshot'lar korunur. İki eksiksiz liste karşılaştırılarak geri takip etmeyenler, takipten çıkanlar, yeni takipçiler, senin takipten çıktıkların ve yeni takip ettiklerin hesaplanır. Web panelinde CSV dışa aktarma ve tarama geçmişi bulunur.

Eklenti yerel depoda **yalnızca sunucu adresini** saklar. Takipçi listeleri / geçmişi eklentinin kalıcı depolamasına yazılmaz; geçici tarama durumu `chrome.storage.session` alanındadır.

## Güvenlik ve sınırlamalar

Mevcut **HTTP bağlantısı şifreli değildir**. Admin şifresi ve takipçi verileri ağ üzerinde korunmaz. Ayrıca kurulum kodu kaldırıldığı için ilk ziyaret eden kişi admin şifresini belirleyebilir; ilk kurulumu korumalı ağda gerçekleştirin. Bu nedenle korumasız ağlarda kullanmayın; mümkünse özel ağ/tünel kullanın. Kurulum sertifika talep etmez.

Instagram'ın `/api/v1/friendships/{id}/following/` ve `/api/v1/friendships/{id}/followers/` gibi resmî olmayan web uç noktaları değişebilir veya hız sınırı uygulayabilir. Instagram'ın 429 yanıtı tüm API'leri etkileyebilir; kullanıcı profili için gereksiz istek kaldırılmış olsa da takipçi listeleri 429 dönerse tarama durdurulur. Eksik / hatalı liste geçmişe kaydedilmez. Canlı Instagram taraması henüz ayrıca doğrulanmalıdır.

## Geliştirme

```bash
go test ./...
go build -o follower .
bash -n install.sh uninstall.sh
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
```

Node.js burada sadece isteğe bağlı geliştirici **sözdizimi kontrolü** içindir; production sunucuda kullanılmaz.

Referanslar: [miraccan00/ig-follow-tracker](https://github.com/miraccan00/ig-follow-tracker) ve [EdvinCodes/InstagramUnfollowers](https://github.com/EdvinCodes/InstagramUnfollowers). Kaynak kodları kopyalanmadı.

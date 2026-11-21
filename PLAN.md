# PLAN: przenoszenie handlerów HMI do backendu w przeglądarce

Dokument planistyczny — **kod handlerów jeszcze nie jest pisany**. To lista etapów,
kolejność i kryteria odbioru.

Stan: 2026-11-18. Źródło referencyjne: `/home/michal/Dokumenty/exycalEmu/emulator`
(`backend.py`, `handlers.py`, `modules/*.py`, `state.json`, `persistency.json`, `config.json`).

---

## 1. Cel i zakres

- Odtworzyć **zachowanie** modułów z backendu Python w `backend/modules/*.js`.
  Protokół (framing, dispatch, persistency, `get(All)Properties`, generyczne `set*`)
  jest już zrobiony w `backend/hmi-backend.js` — tego nie ruszamy.
- **Wymagania przeglądarki:** Chrome **108+** albo Firefox **111+**.
  (Wybór katalogu muzyki to `showDirectoryPicker()`, więc praktycznie Chromium —
  Firefox 111+ ma tylko OPFS; patrz etap 6 i ryzyka.)
- Każdy etap kończy się działającą aplikacją: przybywa ekranów/opcji, nic nie regresuje.
- Handlery piszemy **1:1 z sekcjami Pythona**, z komentarzem `// handlers.py:242-388`
  w nagłówku pliku, żeby dało się wracać do źródła.

**Poza zakresem (świadomie):**

| temat | dlaczego |
|---|---|
| realny Bluetooth (`modules/btreal.py`, `bt_*.ps1`) | przeglądarka nie ma dostępu do stosu BT; telefon tylko symulowany |
| xlety (`modules/xlets.py`, `xlets/`) | osobne aplikacje AIR; najpierw rdzeń HMI, xlety później |
| SvcIpc / Java (`modules/svcipc.py`) | wołane przez xlety; wracamy do tego razem z xletami |
| `splash.py`, `panel.html`, `platform_support.py` | adl/wine/Hyprland, okno HMI — u nas HMI to sam SWF w Ruffle |
| XM przez HTTP (`modules/sxm.py` — część sieciowa) | brak sieci w założeniach; tylko dane demo |

`audio.py` **jest w zakresie**, ale inaczej: odtwarzanie i skanowanie biblioteki robimy
przez Web Audio + **File System Access API** (`showDirectoryPicker()`), patrz etapy 4 i 6.

---

## 2. Co już jest (punkt startowy)

- [x] protokół NUL-framing, `Length` stripping, `FrameReader`/`encodeFrame` (`backend/protocol.js`)
- [x] dispatch: `Subscribe`/`Unsubscribe`/`Command`/`EmitSignal`/`subscribeNameHasOwnerNotification`
- [x] generyczne `getProperties`/`getAllProperties`/`setProperties`/`set*`, `_replies`, `_props`, `NESTED`
- [x] persistency `read`/`write` + zapis do `localStorage`
- [x] `localSocketProvider` w Ruffle (bez sieci) + HUD Flash/Backend z autoscrollem
- [x] AIR VFS w forku: `File.desktopDirectory` → `vfs://desktop/` w `localStorage`,
      katalog aplikacji = katalog descriptora (`hmi/`)
- [x] runtime patch w forku: po inicjalizacji klasy
      `com.nfuzion.framework.global.Framework` w trybie AIR ustawiane jest
      `enableTrace = true`, więc `Framework.Trace()` (i każdy `trace()`) trafia
      do zakładki Flash
- [x] dane referencyjne w emulatorze: `state.json`, `persistency.json`, `config.json`,
      `schema.json`, `tones/`, `sounds/`, `splash/`, `themes`

---

## 3. Weryfikacja wykonalności (probe, 2026-11-18)

Sprawdzone bez zmian w repo — do działającego backendu dopisane w konsoli trzy odpowiedzi:

1. `Audio.getAudioSource` → `{ "source": "fm" }`
2. `AppPersistenceManager.read` → `{ "read": { "res": { "key": "AppsExist", "value": false } } }`
3. `readPPS.getPPSValue` → `{ "DEST": 221 }` (`attribute: "DEST"`)

Efekt: aplikacja **wychodzi z „Loading…”**, ładuje `TaskBar.swf`, `StatusBar.swf`,
`AppsHomeScreen.swf`, pokazuje disclaimer, a po `Accept` — pełny ekran domowy
(zegar, kafle aplikacji, taskbar). Trace kończy się `<HMICore> [ IDLE ]`.

Wnioski, które wchodzą do planu jako fakty:

- `AudioManager.isReady()` = połączenie + `mReady`, a `mReady` ustawia **wyłącznie**
  odpowiedź `getAudioSource` zawierająca `source` (`AudioManager.as:845-856`).
  Samo `getProperties` nic tu nie daje.
- `AppManager.isReady()` czeka na `mAppsExist != "notReady"`, ustawiane w
  `appPersistencyMessageHandler` — a ten event dostaje tylko odpowiedź `read` z `res`
  (`AppManager.as:997-1013`). Nasza obecna odpowiedź `{"read":{"err":"notFound"}}`
  nie wystarcza → HMI retry'uje co ~40 ms.
- Gdy któraś bramka nie jest spełniona, HMI **wiruje** (4901 linii trace w 20 s,
  `PERIPHERAL: WAIT - [class …]` w kółko) — to najlepszy objaw diagnostyczny.
- `readPPS.getPPSValue` (DEST=221) jest ponawiany co 3 s, dopóki nie dostanie wartości.

---

## 4. Architektura docelowa

```
backend/
  handlers.js          # rejestr: importuje moduły i wywołuje ich register()
  hmi-backend.js       # (bez zmian) protokół + generyki + registry
  protocol.js          # (bez zmian)
  index.js             # publiczne API
  data/
    state.json         # seed stanu (jak emulator/state.json)
    config.json        # „auto”: model, motyw, język, ostatni ekran
    persistency.json   # wartości startowe persistency (z _persist)
    phones.json        # symulowane telefony / książka telefoniczna
    media.json         # demo biblioteka USB
    tuner.json         # pasma, stacje, presety
    beeps.json         # tabele segmentów tonów (kopia emulator/beeps.json)
  lib/
    timer.js           # after()/every() zamiast threading.Timer
    units.js           # °F/°C, jednostki z PersonalConfig
    audio.js           # Web Audio: synteza beepów z beeps.json, unlock, gain/pan
    folder.js          # File System Access: wybór katalogu, skan, tagi, cache
    player.js          # HTMLAudioElement + Web Audio: play/pause/seek, postęp
    browse.js          # drzewo przeglądania dla Media
  modules/
    clock.js  app-manager.js  pps.js       # etap 1
    settings.js                            # etap 2
    hvac.js                                # etap 3
    audio.js                               # etap 4
    tuner.js                               # etap 5
    media.js                               # etap 6
    navigation.js                          # etap 7
    phone.js                               # etap 8
    vehicle.js  drivemode.js               # etap 9
    speech.js                              # etap 10
    sxm.js                                 # etap 11
  test/
    replay.test.js     # ramki z fixture → oczekiwane odpowiedzi
    fixtures/*.jsonl
```

Zasady:

- `backend/handlers.js` ma tylko listę `import … ; register(backend)`. Zero logiki.
- Jeden moduł JS = jeden plik źródłowy Pythona (lub jedna sekcja `handlers.py`).
- Stałe/tabele/dane → `backend/data/*.json`, nie do kodu handlera.
- W handlerach używamy tylko API backendu: `send`, `emit`, `broadcast`, `setProperty`,
  `setSignals`, `moduleStore`, `propStore`, `propsOf`, `on`, `alsoOn`, `onEmitSignal`.
- **Reguła `res`:** każda odpowiedź na `read` musi mieć `res` (HMI rozróżnia jego brak).
  Dlatego persistency startuje z seeda `_persist` z `state.json`, a nie z pustego
  `localStorage`.
- Brak sieci, brak systemowego I/O. Czas → `lib/timer.js`; dźwięk → `lib/audio.js`
  (beepy) i `lib/player.js` (muzyka, dzwonek); pliki użytkownika → `lib/folder.js`
  (File System Access API, za zgodą użytkownika); pliki aplikacji → HTTP z `hmi/`;
  dane → `localStorage`/VFS.

---

## 5. Etapy

### Etap 0 — harness i diagnostyka (≈0,5 dnia)

Cel: móc zmierzyć postęp i złapać regresje bez klikania wszystkiego ręcznie.

- [ ] `tools/hmi-decompile.sh` — eksport skryptów z `hmi/*.swf` przez `ffdec` do `/tmp`
      (komendy w załączniku C), żeby zawsze dało się sprawdzić kształt wiadomości.
- [ ] `tools/analyze-log.mjs` — statystyki `Dest`/komenda + lista `?? unhandled`
      z nagrania sesji.
- [ ] Nagrywanie sesji do fixture: `?record=1` (albo przycisk w HUD) → `.jsonl` z `<<`/`>>`.
- [ ] HUD: licznik `unhandled: N` w pasku (obok `in/out`), zerowany przy przeładowaniu.
- [ ] `backend/test/replay.test.js` — szkielet: wczytaj fixture, odtwórz `<<`,
      porównaj `>>` (znormalizowane).

**Odbiór:** `npm test` przechodzi na pustym fixturze; ekran domowy ma policzone `??`.

---

### Etap 1 — „boot unlock” + dane bazowe (najważniejszy)

Cel: aplikacja wychodzi z „Loading…” **bez** żadnych ręcznych sztuczek.

- [x] `backend/data/state.json` — port `emulator/state.json`
      (moduły `Audio`, `AudioSettings`, `Clock`, `Tuner`, `_replies`, `_props`, `_persist`).
- [x] `backend/data/persistency.json` — seed z `_persist`
      (`AppPersistenceManager.AppsExist = false`, `Persistency.DisclaimerAccepted`).
- [x] `backend/modules/app-manager.js` — `AppPersistenceManager.read` → `res`;
      `AppPersistenceManager.write` (już generyczne, ale sprawdzić `res`).
- [x] `backend/modules/audio.js` (cz. 1) — `Audio.getAudioSource`,
      `Audio.getAvailableAudioSources` (z `_replies`).
- [x] `backend/modules/pps.js` — `readPPS.getPPSValue` (`DEST` = 221, `ECUPartNo`).
- [x] `backend/modules/clock.js` — `Clock.getTime` + ticker minutowy (`Clock.time`, NESTED).
- [x] `backend/lib/timer.js` — `after(ms, fn)`, `every(ms, fn)` (odpowiednik `threading.Timer`).
- [x] `handlers.js` — rejestracja modułów etapu 1.

**Odbiór (zweryfikowany w Chromium, 2026-11-18):**
trace zawiera `PERIPHERAL: READY!` dla `AudioSettings`, `AudioManager`, `AppManager`
i kończy się `<HMICore> [ IDLE ]`; renderuje się home screen i disclaimer;
`in`/`out` rosną liniowo (brak pętli retry); zero `??` z listy bootu.
Stan: 98/98 modułów `READY`, jeden przejściowy `WAIT` na `AudioManager`,
156 linii trace, `IDLE` ×2, 0 błędów JS. Pozostałe `??` to etapy 2–9
(HVAC, Media, nav, phone, DAB, platform) — nie blokują bootu.

**Ryzyko:** `source` musi być spójne z `availableAudioSources` (inaczej UI audio
pokaże „brak źródła”); `AppsExist=false` decyduje, czy HMI pokazuje sekcję apps.

---

### Etap 2 — ustawienia i personalizacja (`modules/settings.py`, 485 l.)

Zakres:

- [x] `PersonalConfig` — `getProperties`/`setProperties` (generyczne + hook),
  `getCustomUnitProperties`, `screenTurnedOff`; zapis `lang` przez
  `VehicleStatus.language`; `units` przepisuje komplet jednostek z `settings.json`.
- [x] `VehSetting` — `getProperties` (generyczne), `setProperties` z partnerem
  fotela (grzanie ↔ wentylacja).
- [x] `platform.*` — `get_all_versions`, `get_eq_version`, `get_translation_version`,
  `get_partnumber`, `get_serialnumber`, `get_service_flags`, `get_variantinfo`,
  `clearCustRadioSettings` / `do_factory_reset` (restore defaults).
- [x] `Clock` — `setTime`, `adjustManualOffset`, `adjustMonth/Year`,
  `getOffsetValues`, `setProperties`; offset trzymany w `modules/clock.js`,
  ticker i `getTime` używają go automatycznie.
- [x] `AudioSettings` — `setEqualizer`, `setBalanceFade`, `setLoudness`,
  `setSpeedAdjustedVolume`, `setSurroundSoundStatus`, `setSurroundSoundAvailable`;
  `get*` z `_replies` są aktualizowane przy każdej zmianie.
- [x] `VehicleStatus` — `getKeySenseSecurityPIN`, `setSpeedLockOutFeature`.
- [x] `backend/data/settings.json` — wyciągnięte z Pythona tabele i domyślne.
- [x] `backend/modules/anti-theft.js` — `getAntiTheftState`/`getProperties`;
  bez tego ikona Settings jest zablokowana (`AppSettings.as:refresh()`).

**Odbiór:** ekran Settings otwiera się i zapisuje zmiany (persistency + `localStorage`);
zmiana jednostek natychmiast przestawia format temperatur/dystansu w UI.

**Uwaga:** jednostki są zależnością etapu 3 (HVAC) — dlatego Settings idą pierwsze.

**Weryfikacja (Chromium, 2026-11-19):**
ekran `Settings` otwiera się z listy Apps (po dodaniu `AntiTheft.getAntiTheftState`),
`Settings > Units > Metric` wysyła `PersonalConfig.setProperties {"units":"metric"}`,
backend odpowiada kompletnym zestawem sygnałów (`speedUnits`, `distanceUnits`,
`fuelConsumpUnits`, `capacityUnits`, `pressureUnits`, `temperatureUnits`,
`horsepowerUnits`, `torqueUnits`), a snapshot ląduje w
`localStorage["air-browser-port:persistency"].__settings`. Po przeładowaniu strony
`PersonalConfig` wstaje z `units=metric` / `speedUnits=kph` i ekran Units pokazuje
zaznaczony Metric. Ekrany `Display` (`SettingsDisplayScreen.swf`) i `Clock`
(`SettingsClockScreen.swf`) renderują się bez `??`; klik `24 hrs` wysyła
`Clock.setProperties {"timeFormat24":true}`, odpowiedź trafia do stanu i snapshotu
`__settings.Clock`, a pasek statusu i wiersze ekranu przechodzą na 24 h. Brak `??`
dla modułów etapu 2. Format `--°` w Climate pozostaje placeholdem do etapu 3 (HVAC).

---

### Etap 3 — HVAC / klimatyzacja (`handlers.py:242-388`)

Zakres:

- [x] `getZoneProperties`, `getControlProperties`, `setControlProperties`
  (eventy `press`/`release`, toggles, `fanUp/fanDown`, `tempUp/tempDown`, `VENT_MODES`, `WAKES`).
- [x] Konwersja °F ↔ jednostka użytkownika z `PersonalConfig` (`RANGE`, `lo`/`hi`).
- [x] Sygnały `zone` (`hvac_emit`) i publikacja po zmianie jednostek.
- [x] `backend/modules/hvac.js` — stan modułu (bez wpisu w `state.json`, jak w Pythonie).

**Odbiór:** ekran Climate: +/- temperatury w obu jednostkach, OFF i „wybudzanie”
przy dowolnej akcji, fan 0-7, tryby nawiewu, AC/MAX/recirc/auto/sync.

**Ryzyko:** `setControlProperties` przychodzi 68× w sesji — najgorętsza ścieżka;
uważać na kolejność emisji (`zone` vs `getControlProperties`).

**Weryfikacja (Chromium, 2026-11-19):**
klik `Climate` w dolnym pasku otwiera ekran z `72°` po obu stronach, fanem 3,
`MAX A/C`/`A/C`/`recirc`/`AUTO`/`FRONT`, czterema trybami nawiewu, `OFF` i `SYNC`.
`tempUp`/`tempDown` wysyłają `setControlProperties {"zone":"frontLeft","controls":{"tempUp":"press"}}`,
backend odpowiada `{"HVAC":{"zone":{"zone":"frontLeft","controls":{"temp":"73"}}}}`,
a UI pokazuje 73°, 74°. 16× `tempDown` dochodzi do `LO` (sygnał `"temp":"lo"`);
`Settings > Units > Metric` publikuje oba fronty jako `23` (73 °F) i Climate
pokazuje `23°`, kolejne +/- dają 24°/25°, a powrót na `Imperial` — `75°` (24 °C).
Fan: `fanUp`/`fanDown` 7→6→5, przy 7 `fanUp` nie emituje nic, przy 1 `fanDown`
zatrzymuje się; ręczna zmiana dokłada `"auto":"off"`. `MAX A/C` włącza `recirc`,
`AUTO` włącza `AC`, `SYNC` kopiuje lewą temperaturę na prawą, a dotknięcie prawej
zdejmuje `sync`. `OFF` pokazuje ekran `Climate Off` z przyciskiem `ON`, który wraca
do panelu. Brak `??` dla `HVAC` w logu backendu (86 ramek `HVAC` w sesji).
Testy w Node (`hvac-test.mjs`): pełne pokrycie konwersji °F/°C, granic `lo`/`hi`,
toggles, `sync`, fan 0-7 i trybów nawiewu — OK.

---

### Etap 4 — audio: źródło, głośność, beepy (`handlers.py:389-412, 866-968`, `audio.py:74-160`)

Zakres:

- [x] `Audio.setAudioSource`, `setMute`, `subscribe audioSource`/`userMuteState`.
- [x] `AudioSettings.setVolume` (+ `cap = 38`, aktualizacja `_replies.getVolume`).
- [x] `AudioMixerManager.confirmationTone` → `lib/audio.js`: **synteza z `data/beeps.json`**
  (te same tabele `freq`/`freq2`/`duration`/`level`/`waveform`, co `audio.py:_segment_wave`),
  `AudioBuffer` + `AudioBufferSourceNode`, bez plików `tones/*.wav`.
  Python generuje te WAV-y tylko dlatego, że MCI/mpv nie umieją syntezy; przeglądarka umie.
- [x] `lib/audio.js` trzyma jeden `AudioContext`, `masterGain` i mapę `name → AudioBuffer`
  (renderowane raz, przy pierwszym użyciu).
- [x] **Unlock:** `AudioContext` startuje w stanie `suspended` (autoplay policy). Pierwszy
  gest użytkownika (klik/dotyk w dowolnym miejscu strony lub przycisk w HUD) robi
  `resume()`; do tego czasu beepy są kolejkane/ignorowane, a HUD pokazuje `audio: off`.
- Ticker audio: postęp odtwarzania dopiero w etapie 6 (Media).

**Odbiór:** klik w UI daje beep (`CONF_1` itd.), głośność (knob sprzętowy →
`ICS.UpdateVolume` → `AudioSettings.HWVolumeRelative`) i mute działają;
po reloadzie pierwszy klik włącza dźwięk (bez błędów w konsoli).

**Uwaga:** `audio.py` przenosimy **funkcjonalnie**, nie linia w linię: MCI/mpv/ffplay
zastępuje Web Audio, a `make_tones()` → synteza w `lib/audio.js`.

**Weryfikacja (Chromium, 2026-11-19):**
HUD pokazuje `audio: off` po przeładowaniu i `audio: on` po pierwszym geście; oba
`AudioContext` (nasz i Ruffle) startują jako `suspended`, a gest tylko robi `resume()`
na naszym — bez opóźniania pierwszej obsługi kliknięcia. Klik `A/C` na ekranie Climate
wysyła `AudioMixerManager.confirmationTone {"type":"CONF_1"}`, a `lib/audio.js`
planuje dokładnie jedno źródło na własnym kontekście (czas trwania 0.110975 s =
2447/22050 dla `CONF_1`). Wstrzyknięte `AudioSettings.setVolume {"volume":25}`
rozgłasza `{"volume":{"volume":25,"cap":38}}` i aktualizuje `_replies.getVolume`
(pasek statusu pokazuje 25); `Audio.setMute {"state":true}` rozgłasza
`userMuteState {state:true}` i HMI pokazuje „Music Muted”. `Audio.setAudioSource
{"source":"aux"}` rozgłasza `{"audioSource":{"source":"aux","service":"hmi",
"aux":{"id":3,"name":"AUX"}}}` i podmienia `_replies.getAudioSource` (etykieta radia
w pasku znika, bo AUX to nie radio). Brak `??` dla `Audio`, `AudioSettings`
i `AudioMixerManager`, brak błędów strony. Testy w Node (`beeps-test.mjs`: 19 tabel
zgodnych z PCM z `audio.py`; `audio-test.mjs`: źródło, mute, głośność, subskrypcje,
beep) — OK. Ten HMI nie ma ekranowego suwaka głośności głównej (jest w Audio
Settings tylko per-źródło), więc `setVolume`/`setMute` sprawdzono wstrzykując
komendy przez prawdziwe połączenie.

---

### Etap 5 — Tuner AM/FM (`handlers.py:413-542`)

Zakres:

- [x] `setWaveband`, `setFrequency`, `seekPress`, `seekUpDown`, `setTuneKnobEnabled`.
- [x] Presety: `requestRecallPreset`, `requestStorePreset`, `requestClearPreset`,
  `requestPresetPosition` + `PresetPersistencyManager` (persistency).
- [x] `presetList`, `presetPositions`, `stationInfo` w stanie modułu `Tuner`.
- [x] DAB (`DABTuner*`) — tylko stuby `getProperties` (jednostka NAFTA bez DAB).

**Odbiór:** ekran Radio: zmiana AM/FM, kręcenie częstotliwością, seek, presety 1-6
zapis/odczyt przetrwa reload. `??` dla DAB zredukowane do zera.

**Weryfikacja (Chromium, 2026-11-19):**
Ekran Radio startuje na `101.1 WCBS` z podświetlonym presetem 5; `state.Tuner` ma
`presetList`/`presetPositions {fm:4, am:3}` i `seekStatus {seekType:"SEEK_STOP"}`.
Klik `AM` przełącza na `880 WCBS`, podświetla preset 4 i pokazuje listę 570-1130 kHz;
`FM` wraca na `101.1`. Seek w przód z 101.1 po ~0,6 s ląduje na `102.7 KIIS`
(preset 6), seek w tył wraca na `101.1`. Dłuższe przytrzymanie presetu 1 (>2 s)
wysyła `requestStorePreset {"Position":0}`, backend odpowiada
`presetUpdate {"wb":"FM","presetId":0,...}` + nową `presetList`, a slot 1 pokazuje
`102.7`; zwykły klik presetu 5 przywołuje `101.1`. Po reloadzie slot 1 nadal ma
`102.7`, co potwierdza zapis w `__tuner` (`localStorage`) oraz `state.Tuner`.
Brak `??` dla `Tuner` i DAB (stuby odpowiadają na `requestGetDab2DabLinkingSwitch`
i `requestGetDab2FmLinkingSwitch`); `seekRelease` z puszczenia przycisku jest
świadomie ignorowany jak w referencji. Testy w Node (`tuner-test.mjs`): seed,
getProperties, AM/FM, clamp, krok gałki, seek w obie strony z zawijaniem,
store/recall/clear presetów, persistencja i hook `Audio.setAudioSource` — OK.

**Uwaga:** `state.json` ma przestarzałe `seekStatus {"seekType":"stop"}` (małe
litery), a HMI porównuje je z `TunerSeek.sSTOP` (`"SEEK_STOP"`). Bez poprawki
`localSeek` nigdy nie wraca do stanu stop: long-press presetu wysyła
`seekInterrupt` zamiast zapisu. Dlatego seed modułu publikuje `SEEK_STOP`.

---

### Etap 6 — Media / USB + prawdziwa muzyka z dysku (`handlers.py:543-865`, `audio.py:1-73, 161-559`)

Zakres:

- [x] Biblioteka demo `backend/data/media.json` (2 urządzenia: `usb1` SANDISK
  16GB i `btsa` Pixel 8; 15 utworów) — działa od razu, bez zgody użytkownika.
  Okładka zostaje domyślna (`getAlbumArt {path:"", msid}`), bo demo nie ma plików.
- [x] Wybrany katalog **zastępuje** demo-bibliotekę urządzenia (jak `load_music()`
  w Pythonie: `LIBRARY` + reset przeglądania), z powrotem do demo przez „Use demo”.
- [x] `getDevices`, `selectDevice`, `deSelectActiveDevice`, `getCurrentTrackList`,
  `getAlbumArt`, `getItems`, `gotoRoot`, `gotoPrevious`, `selectItem`, `selectAll`.
- [x] `next`, `previous`, `seekToTime`, `setProperties` (repeat/shuffle), `readyToBrowse`
  (powtórzone po 1 s, żeby ekran Media nie został wyszarzony).
- [x] **`lib/folder.js` — File System Access API** (odpowiednik `audio.scan()`):
  - HUD: przycisk „Music folder…” → `showDirectoryPicker({ mode: "read" })`
    (Chrome 108+; Firefox 111+ nie ma pickerów dysku, tylko OPFS — tam zostaje demo).
  - Rekurencyjne `for await (const [name, handle] of dir.entries())` po podkatalogach;
    filtr rozszerzeń `{.mp3,.m4a,.aac,.wma,.wav,.flac}` (jak `EXTS` w `audio.py`).
  - Tagi: ID3v2 (2.2/2.3/2.4, w tym unsynchronisation) + ID3v1, atomy MP4 (`ilst`),
    komentarze FLAC i `LIST/INFO` w WAV; brak tagów → `<Artist>/<Album>/<nazwa>`
    z nazw katalogów i pliku (jak `audio.py`).
  - Czas trwania: `TLEN`, `mvhd`, FLAC `STREAMINFO`, rozmiar `data` w WAV; player
    uzupełnia realną długością po `loadedmetadata`.
  - Cache tagów w `localStorage` (`air-browser-port:media-tags`, klucz `path`,
    wartość `lastModified:size` + tagi — odpowiednik `music_cache.json`);
    zmiana pliku unieważnia wpis.
  - Uchwyt katalogu w IndexedDB (`air-browser-port` / `media` / `music-folder`);
    po reloadzie `queryPermission()` → `requestPermission()` (wymaga gestu);
    brak zgody = biblioteka demo + HUD „Allow folder…”.
- [x] **`lib/player.js` — odtwarzanie** (odpowiednik `audio.run()`/`audio_want()`):
  - `HTMLAudioElement` jako źródło (`createMediaElementSource`) → `GainNode` →
    `StereoPannerNode` (balance −10…+10 jak `_volumes()`) → `masterGain` z `lib/audio.js`.
  - Stan `want`: `{path, file, playing, start, seek:{gen, sec}, gain, pan}`;
    zmiana `gen` = przeskok; `playing=false` = pauza (nie restart).
  - Zdarzenia → `audio_report`: `loaded` (długość), `position` (~1 s), `ended`
    (repeat=song ? ta sama : następna), `failed` (log `!!` + skip).
  - Głośność z `AudioSettings` + mute z `Audio.userMuteState`.
- [x] Ticker `playTime`: realne odtwarzanie z pozycji elementu, demo z zegara
  monotonicznego; 250 ms pompa `want` i 1 s ticker (w Node testy wołają `pump()`/`tick()`).

**Odbiór:** ekran Media: lista utworów, okładka, play/pause/next/prev, postęp,
wybór źródła USB; `readyToBrowse` nie zapętla UI. Po wybraniu katalogu z muzyką:
lista z tagów/nazw, odtwarzanie słyszalne, seek i następny utwór działają,
`ended` przechodzi dalej, a po reloadzie wystarczy ponowna zgoda na katalog.

**Weryfikacja (Chromium 157, 2026-11-19):**
Demo: ekran Media pokazuje `1 of 15`, `Highway Star`, `0:02 / 6:05`; prev/pause/next
działają, lista utworów (`trks`) przewija się do 10-15, klik wiersza 13 włącza
`Midnight City`, a przeciągnięcie playheada z 0 do ~231 s ustawia `playTime.time`
(bez `?? Media`). Ikona Bluetooth przełącza źródło na `btsa` (`Pixel 8`, `readyToBrowse
{id:2}`), USB wraca do `usb1`. Do OPFS wgrano `Music/Test Artist/Test Album/`
z tagowanymi WAV (8 s i 5 s): „Music folder…” skanuje 2 utwory z tytułami/tagami,
`<audio>` gra z `blob:` (currentTime 2,7 → 5,3 s), seek do ~7 s, next na `Beta Song`
(5 s), koniec pliku przewija do `Alpha Song`; HUD `music: 2 tracks`. Po reloadzie
z `queryPermission()="prompt"` zostaje demo + „Allow folder…”, po zgodzie skan
wraca, a „Use demo” przywraca 15 utworów i czyści uchwyt (kolejny reload = demo).
Testy w Node: `media-test.mjs` (boot, getProperties/getDevices, transport, seek,
lista, drzewo browse, repeat/random, hook źródła, HUD gain/pan, ticker, `ended`/
`failed`, podmiana biblioteki) i `folder-test.mjs` (ID3v1/v2/MP4/FLAC/WAV, fallback,
skan, sortowanie, cache i jego unieważnienie) — OK.

**Ryzyko:** duży katalog = długi skan (HUD pokazuje liczbę plików; skan oddaje
wątek co 25 plików przez `requestAnimationFrame`); `wma` nie zagra w Chromium
(zostaje na liście, `failed` → skip); `requestPermission()` musi być w geście użytkownika.

**Później (opcjonalnie):** odtwarzanie plików z VFS `File.desktopDirectory` (bez zgody
użytkownika) jako drugie źródło obok katalogu z FS Access; ducking podczas połączenia
telefonicznego razem z modułem `Phone` (dziś brak źródła stanu połączeń w JS).

---

### Etap 7 — nawigacja i warstwy (`modules/nav_apps.py`, 96 l.)

Zakres:

- [x] `NDR.JSON_GetProperties` — `POS_Position`, `POS_CalibrationLevel` (≥3),
  `SEN_GPSInfo`, `SEN_GPSSatInfo`, `SEN_ReverseGear`, `POS_VehicleSpeed`
  (stała pozycja Detroit; `inprop` filtruje tabelę, nieznane klucze są pomijane).
- [x] `Navigation.JSON_GetProperties` — `ETC_SoftwareVersion` **i** `ETC_DatabaseVersion`
  w jednej ramce (inaczej `UpdateCheck` czeka w nieskończoność), a potem
  `ETC_IsActivated/IsOperable` — każdy w osobnej ramce, bo
  `Navigation.distribute_JSON_Prop` obsługuje tylko pierwszą właściwość.
- [x] `NavigationPersistency` — format `verify_key`: zapis trzyma cały obiekt
  `Nav_X` (m.in. `verify_key`), odczyt zwraca go w całości; nieznany klucz
  odpowiada `{}` (nie `Empty` i nie generyczne `{key, err}`), co HMI liczy jako
  pusty odczyt i zamienia na `null`. Zapis jest od razu mirrorowany przez
  `onPersistencyChange`, więc przetrwa reload.
- [x] `DisplayManager.requestDisplay` po 2 s od odczytu `Nav_ActGuidance`
  (`layer:"map"`, `visible:"false"`, `granted:"true"`) — bez tego
  `MainBackgroundScreen` nie odświeża konfiguracji mapy.
- [x] `NavTrailInfo` z `backend/data/navfs.json`: `ls` (ścieżki `/fs/...`),
  `ls_userTracks`, `getTracksFolder`; `mkUserTracksFolder`/`mvTrack`/`rmTrack`
  dostają ack (`result:0`), bo VFS jest tylko do odczytu. Lista jest pusta, więc
  `TrailManager` kończy pętlę retry i nie próbuje otwierać plików `.gpx`.
- [x] `nav_apps.init`: `Audio.availableAudioSources.usb1.type = "usb"` (zarówno
  w module store, jak i w `_replies.Audio.getAvailableAudioSources`) — inaczej
  ekran Media porównuje `usb1` z `usb` i czyści metadane.

**Odbiór:** brak `#1009` w konsoli, nav raportuje „ready”, kafel nav nie wywala UI;
`?? NavTrailInfo.ls` znikają.

**Weryfikacja (Chromium 157, 2026-11-19):**
`Navigation.parseETC_IsActivated(true)` → `ETC_IsOperable(true)` →
`Navigation reportGuidanceRestarterFinished` → `Navigation NAV_STATE_PARTIALLY_READY`;
`NDR` odpowiada pozycją 42.3314/-83.0458 i poziomem kalibracji 3, a `Nav_MAP`/
`Nav_Trips_00..11`/`Nav_ActGuidance` są czytane bez „no data”. Po 20 s
`TrailManager` wysyła `ls_userTracks`, `getTracksFolder` i pięć `ls` — dostaje
listingi i przestaje retryować (`?? NavTrailInfo.*` brak). Wejście w Nav z dolnego
baru otwiera disclaimer, a po „Accept” pełne menu (Where To?/View Map/Information/
Emergency); View Map ładuje `NavMapScrollingScreen` i `MapController.selectConfiguration(0)`
bez `#1009`. Ekran Media nadal gra listę demo (kontrola regresji `type:"usb"`).
Test Node `nav-test.mjs`: wersje w jednej ramce, aktywacja/operability, wszystkie
props NDR, format `verify_key`, pusty odczyt, refresh DisplayManagera, listingi
NavTrailInfo i `usb1.type` — OK.

**Uwaga:** sama mapa jest rysowana natywnie na prawdziwym radiu — u nas nie ma
mapy; chodzi tylko o gotowość i menu. `Navigation.MAP_Controls`,
`Info_GetList`, `ETC_SetLanguage` itp. pozostają nieobsłużone (tak jak w Pythonie);
nie blokują menu ani nawigacji HMI.

---

### Etap 8 — telefon / PIM bez realnego BT (`modules/phone.py`, 832 l.)

Zakres:

- [x] `BluetoothGAP` — status, lista sparowanych (z `backend/data/phones.json`),
  `startDeviceSearch`, `securePairingReply`, `startServiceConnect/Disconnect`,
  `startDeviceUnpairing`, `setFavourite`.
- [x] `BluetoothHFP` — stan połączenia (ringing/dialing/active/held).
- [x] `PhoneBook`, `PhoneCallList`, `PimService` — kontakty, ostatnie połączenia, SMS-y.
- [x] Ringtone przez `lib/player.js` (`backend/assets/incomingCallDefaultRingtone.wav`):
  osobne `HTMLAudioElement` z `loop=true` na kanale „ring”, niezależne od muzyki.
- [x] Podczas rozmowy media są ściszane/wstrzymywane (ducking w `lib/player.js`,
  jak `in_call` w `audio_want()`).

**Odbiór:** ekran Phone: sparowany telefon, kontakty, recents, SMS, połączenie
wychodzące/przychodzące (stan + dzwonek, muzyka cichnie). Zero prób realnego BT.

**Weryfikacja (Chromium 157, 2026-11-20):**
ekran Phone pokazuje sparowany „Pixel 8” i Phone Ready; **phonebook** otwiera listę
22 kontaktów (Mobile/Favorites), **recent calls** listę 12 pozycji z filtrami
All/Incoming/Outgoing/Missed, a **messaging** 5 wiadomości ze skrzynki Inbox.
Klawiatura dial: `5551234` → „Calling… 555-1234” → stan `active` (auto-answer po
3 s), End kończy. Połączenie przychodzące od „Mom”: ekran Answer/Ignore, kanał
„ring” gra zapętlony `incomingCallDefaultRingtone.wav` (`loop=true`,
`paused=false`), element muzyki jest wstrzymany; Answer przechodzi w `active`
i zatrzymuje dzwonek. Test duckingu z prawdziwym MP3: podczas `ringing` i `active`
element muzyki `paused=true`, po rozłączeniu wznawia od zapisanej pozycji.
Wszystko w przeglądarce — brak prób realnego Bluetooth (zero gniazd/socketów BT).
Test Node `phone-test.mjs`: GAP pairing/unpairing, HFP dial/answer/hangup,
phonebook, recents, SMS i persistencja — OK.

---

### Etap 9 — pojazd, Drive Mode, reszta (`modules/vehicle.py`, `drivemode.py`, `handlers.py:228-241`)

Zakres:

- [x] `VehicleConfig` z `backend/data/config.json` (model auta → SRT / Performance Pages /
  Drive Modes / theme brand) — wypełniane przy starcie, jak w `vehicle.apply()`.
  Domyślnie `challenger_hellcat`; model można nadpisać przez `?vehicle=<nazwa>`.
- [x] `DriveMode` — `getAllProperties`, `getProperties`, `getDriveModeVersion`,
  `getLoggingEnable`, `setLoggingEnable`, `setProperties`, `copyDriveModeLogToUSB`
  (+ tabele z `config.json.driveMode.tables`).
- [x] `AntiTheft` — `getAntiTheftState`, `getProperties`.
- [x] `Camera`, `Rse`, `DriverAB`, `HEV`, `VehicleStatus` (sygnały), `SWC`, `AnnouncementMaster`
  (część ack).

**Odbiór:** kafle SRT/Perf Pages zależą od modelu; ekran Drive Mode działa;
`Camera`/`RSE` nie wywalają UI; brak `??` dla podstawowych getterów.

**Weryfikacja (Chromium 157, 2026-11-20):**
`?vehicle=challenger_hellcat` (domyślny) pokazuje kafel **Drive Modes** i ekran SRT
(Power 700+, Transmission Street, Paddle Shifters On, Launch Control, Valet, Red key).
`?vehicle=charger_rt` daje kafel **Perf. Control** i ekran Performance Control/Launch
Control. `?vehicle=grand_cherokee_srt` otwiera Drive Mode z Auto Set-Up, Launch
Control, Valet i wierszem AWD; klik Steering Sport wysyła `setProperties`, zmienia
tabelę custom i live `EPSModeStatus` na `sport`. `Camera.setGear("1"/"0")` nie
psuje UI, `RSE` odpowiada ackami, a w logu Flash nie ma `??` ani błędów dla
Camera/DriveMode/AnnouncementMaster/DriverAB/HEV/SWC (w tej sesji `??` nie było
w ogóle). Test Node `vehicle-test.mjs`: profile, `apply()`, Drive Mode get/set,
logi i persistencja — OK.

---

### Etap 10 — mowa / TTS

Zakres:

- [x] `TextToSpeech` (`speak`, `stop`, `pause`, `resume`) + `UISpeechService` (stub
  zwracający ack, jak w Pythonie) + `AnnouncementMaster` (`announcement`/mute).
- [x] Web Speech API (`speechSynthesis`) jako opcja: głos wybierany z listy
  przeglądarki, wypowiedź asynchroniczna (nie blokuje UI); brak głosów → tylko ack.
- [x] Stany odtwarzania `playStart`/`playEnd`/`notPlaying` wysyłane jako obiekty
  `{state}`; `abort`/`stop` przerywa wypowiedź.

**Odbiór:** komendy nie blokują UI; komunikat TTS jest słyszalny, jeśli przeglądarka
ma głosy; w przeciwnym razie tylko ack (bez `??`).

**Weryfikacja (Chromium 157, 2026-11-21):**
`airSpeech.readout("Hello")` przechodzi w stan `playStart` → `playEnd` (lub od razu
ack, gdy brak głosów), `abort()` kończy wypowiedź; w logu Flash/Backend nie ma `??`
dla `TextToSpeech`/`UISpeechService`/`AnnouncementMaster`. Test Node
`stage10-11-test.mjs`: ack, stany, abort — OK.

---

### Etap 11 — XM / SXM (opcjonalnie) (`modules/sxm.py`, 1077 l.)

Zakres:

- [x] Lokalna lista 51 kanałów (nazwy, kategorie, numery), bez HTTP i bez zewnętrznego
  lineupu.
- [x] Presety, ulubione (`XMFavorites` lokalnie), skip, `XMTrafficJump`, Game Zone,
  Instant Replay i usługi danych (`XMApp`).
- [x] Logo kanałów z `backend/assets/channelart/` (47 PNG z 2019 Uconnect,
  mapowanie SID→obraz z `channelart.db`) i `channelart.js`; `VehicleConfig.destination`
  ustawiony na SXM.

**Odbiór:** ekran SXM z lokalną listą kanałów; `??` dla XM zredukowane.

**Weryfikacja (Chromium 157, 2026-11-21):**
Radio → SXM pokazuje lokalny lineup; tune na kanał 2/34/37, presety i seek działają,
lista kanałów przewija się bez HTTP. `??` zredukowane do pojedynczego
`AudioMixerManager.registerMuteClient {"serviceName":"sdars"}`. Test Node
`stage10-11-test.mjs` (12/12): boot/tune/presety/ulubione/skip/traffic/game zone/
replay/subskrypcje — OK.

---

## 6. Kolejność — uzasadnienie ruchem

Sesja referencyjna `emulator/backend.log`: 1081 ramek z HMI (~2,5 min, bez klikania).

| Dest | ramki | najważniejsze komendy |
|---|---:|---|
| HVAC | 81 | `setControlProperties` ×68 |
| AudioMixerManager | 75 | `confirmationTone` ×64 |
| Tuner | 72 | `getProperties`, `setTuneKnobEnabled`, `setWaveband` |
| Media | 70 | `getCurrentTrackList` ×20, `getAlbumArt`, `getDevices` |
| VehSetting | 69 | `getProperties` ×36, `getAllProperties` |
| Navigation | 58 | `MAP_Controls`, `JSON_GetProperties`, `Info_GetList` |
| Rse | 47 | `requestExitFullScreen` |
| NavTrailInfo | 42 | `ls` ×30 |
| AppManager | 34 | `setAppMenuActive` |
| NavigationPersistency | 28 | `read`/`write` (format `verify_key`) |
| Persistency | 26 | `read`/`write` |

Kolejność = **bramki bootu → najczęstszy ruch → zależności**:
1 (boot: dane + bramki) → 2 (jednostki, od których zależy HVAC) → 3 (HVAC: najgorętszy)
→ 4 (audio, bo dotyk/beep jest wszędzie) → 5 (Tuner) → 6 (Media) → 7 (nav, bo bez
niego są `#1009` i kafel nav) → 8 (telefon) → 9 (pojazd) → 10 (TTS) → 11 (XM).

---

## 7. Testy i weryfikacja

1. **Replay (node:test)** — fixture `.jsonl` (`direction`, `raw`), odtworzenie `<<`,
   porównanie `>>` bez pól zmiennych (`Length`, znaczniki czasu).
2. **Testy jednostkowe** — konwersje °F/°C (`units.js`), drzewo `browse.js`,
   presety (`tuner.json`), `verify_key` dla nav, segmenty beepów (`beeps.json` →
   czas trwania/poziom), cache skanu (`lastModified:size`) i fallback tagów
   (`lib/folder.js`, bez FS API — na atrapie uchwytów).
3. **HUD** — licznik `??` i wpisy w zakładce Backend; cel: 0 `??` na ścieżce etapu.
4. **Checklista ekranów** (ręcznie, Chromium):
   home → disclaimer → Settings → Climate → Radio → Media → Nav → Phone → Drv Mode.
5. **Screenshoty** przy każdym etapie do `docs/screens/<etap>.png` (opcjonalnie).

---

## 8. Ryzyka i otwarte decyzje

- **Timery w tle:** `setInterval` w ukrytej karcie jest dławiony (~1 s). Dla zegara
  OK; dla `playTime` liczyć z `performance.now()` + znacznika startu, nie z liczby ticków.
- **Kolejność ramek:** HMI jest wrażliwe na kolejność (`READY` vs dane). Przy handlerach
  emitujących kilka sygnałów naraz trzymać się kolejności z Pythona.
- **Podwójny stan:** `moduleStore` (sygnały) vs `propStore` (`getProperties`) — Python
  ma to samo; konwencja: `setProperty` zapisuje w `propStore` + emituje sygnał.
- **Duplikacja danych z emulatora:** `state.json`/`config.json` kopiujemy na start,
  ale potem rozjeżdżają się z Pythonem — traktować `backend/data/` jako źródło prawdy
  dla przeglądarki i nie synchronizować w obie strony.
- **Brak `res` = pętla retry.** Każda nowa obsługa `read` musi zwracać `res`.
- **Persistency:** teraz `localStorage`; decyzja przed etapem 2, czy przenieść do VFS
  (`File.desktopDirectory`), żeby AIR-owe `File` widziało te same dane.
- **Model auta:** wybór przez `?vehicle=` / panel HUD — decyzja przed etapem 9.
- **Prawdziwy dźwięk:** decyzja podjęta — beepy i muzyka/dzwonek przez Web Audio
  (`lib/audio.js`, `lib/player.js`), TTS przez Web Speech API tylko jako opcja (etap 10).
- **Wymagania:** Chrome **108+** albo Firefox **111+**. Player i Web Audio działają
  w obu; wybór katalogu muzyki (`showDirectoryPicker()`) tylko w Chromium 108+
  (Firefox 111+ daje OPFS, ale nie pickery dysku), więc tam zostaje biblioteka demo.
  Nie robimy fallbacku `<input type="file" webkitdirectory>` w etapie 6 (możliwy
  później; daje pliki, ale nie trwały uchwyt katalogu).
- **Zgoda i gest:** `showDirectoryPicker()` i `requestPermission()` muszą być
  wywołane z gestu użytkownika; `AudioContext.resume()` też. Po reloadzie uchwyt
  jest w IndexedDB, ale uprawnienie trzeba odnowić — UI ma to sygnalizować
  („Music folder: reconnect”), a nie wywalać błędu.
- **Uchwyty plików:** `File` z uchwytu trzeba pobrać przed odtworzeniem i trzymać
  `ObjectURL`/`Blob`; `HTMLMediaElement` nie czyta z `FileSystemFileHandle`
  bezpośrednio. Unieważniać URL po zmianie utworu.
- **Duże biblioteki:** skan rekurencyjny może trwać; limity (np. 20 tys. plików),
  postęp w HUD, przerwanie skanu po zmianie katalogu.
- **Formaty:** `wma`/część `aac` nie zagra w Chromium — `failed` → skip (jak Python,
  gdy mpv nie umie pliku), bez blokowania listy.

---

## 9. Szablon portu handlera (definition of done)

Dla każdej komendy:

1. Handler w `backend/modules/<modul>.js` + komentarz ze źródłem (`handlers.py:123-145`).
2. Wszystkie stałe/tabele w `backend/data/*.json`.
3. Odpowiedź ma kształt **dokładnie** jak w SWF (sprawdzone w `ffdec` — załącznik C).
4. Test replay: ramka wejściowa → oczekiwana ramka wyjściowa.
5. Brak `??` dla tej komendy w HUD.
6. Ręczny test ekranu (checklista w etapie).
7. Checkbox w tym pliku odhaczony.

Mapowanie Python → JS:

| Python | JS |
|---|---|
| `@on(module, cmd)` | `backend.on(module, cmd, fn)` |
| `B.send(m, payload, conn)` | `backend.send(m, payload, conn)` |
| `B.mod(name)` | `backend.moduleStore(name)` |
| `B.prop_store(name)` | `backend.propStore(name)` |
| `B.props_of(name)` | `backend.propsOf(name)` |
| `B.set_props(...)` | `backend.setSignals(...)` |
| `B.PERSIST` / `PERSIST_FILE` | `backend.persistency` / `onPersistencyChange` |
| `threading.Timer(t, fn)` | `after(t*1000, fn)` |
| `json.dump(...)` | `localStorage` (już) |
| `audio.tone(dir, name)` | `playBeep(name)` z `lib/audio.js` (synteza z `beeps.json`) |
| `audio.scan(dir, cache)` | `scanLibrary()` z `lib/folder.js` (File System Access) |
| `audio.run(want, report)` | `lib/player.js` (`HTMLAudioElement` + Web Audio) |
| `subprocess` / `adl` | nie dotyczy |

---

## Załącznik A — bramki gotowości HMI (z `Peripheral.as`)

`Peripheral.as` ma manifest 98 modułów; boot idzie od priorytetu 5 do 0, a **tylko
4 moduły są asynchroniczne**:

| prio | moduł | `isReady()` | co odblokowuje |
|---:|---|---|---|
| 4 | `VehConfig` | `configured && connected && !firstPass` | `subscribeNameHasOwnerNotification` + subscribe |
| 1 | `AudioSettings` | `configured && connected` | natychmiast po połączeniu |
| 1 | `AudioManager` | `… && mReady` | `Audio.getAudioSource` z `source` |
| 1 | `AppManager` | `… && mAppsExist != "notReady"` | `AppPersistenceManager.read` z `res` |

Pozostałe 94 są `synchronous` → nie blokują „Loading…”. Dlatego etap 1 jest mały,
a jednocześnie krytyczny.

## Załącznik B — mapa źródeł

| źródło | linie | plik JS | etap |
|---|---:|---|---|
| `handlers.py` — Clock | 216-227 | `clock.js` | 1 |
| `handlers.py` — SvcIpc/hmiVars/themes/splash/HMI | 19-215 | — (pomijane) | — |
| `handlers.py` — AntiTheft | 228-241 | `vehicle.js` | 9 |
| `handlers.py` — HVAC | 242-388 | `hvac.js` | 3 |
| `handlers.py` — Audio source | 389-412 | `audio.js` | 4 |
| `handlers.py` — Tuner | 413-542 | `tuner.js` | 5 |
| `handlers.py` — Media | 543-865 | `media.js` | 6 |
| `handlers.py` — Volume | 866-878 | `audio.js` | 4 |
| `handlers.py` — audio output | 879-968 | `lib/player.js` | 4/6 |
| `audio.py` — tagi/skan | 15-73 | `lib/folder.js` | 6 |
| `audio.py` — beepy (tabele + synteza) | 74-160 | `lib/audio.js` | 4 |
| `audio.py` — playery MCI/mpv/ffplay | 161-547 | `lib/player.js` | 6 |
| `audio.py` — pętla `run`/`want`/`report` | 548-559 | `lib/player.js` | 6 |
| `handlers.py` — hardware panel | 969-1014 | — (panel HUD później) | — |
| `handlers.py` — ticker | 1015-1035 | `lib/timer.js` | 1 |
| `handlers.py` — XMFavorites | 1036-1100 | `sxm.js` | 11 |
| `modules/settings.py` | 485 l. | `settings.js` | 2 |
| `modules/nav_apps.py` | 96 l. | `navigation.js` | 7 |
| `modules/phone.py` | 832 l. | `phone.js` | 8 |
| `modules/vehicle.py` | 150 l. | `vehicle.js` | 9 |
| `modules/drivemode.py` | 205 l. | `drivemode.js` | 9 |
| `modules/sxm.py` | 1077 l. | `sxm.js` | 11 |
| `modules/svcipc.py` | 167 l. | — (xlety) | później |
| `modules/btreal.py` | 402 l. | — (realny BT) | poza zakresem |
| `modules/xlets.py` | 1136 l. | — (xlety) | później |

## Załącznik C — jak zaglądać w SWF

```bash
# całe skrypty (AS3) z obu SWF-ów
ffdec -export script /tmp/hmi/main hmi/main.swf
ffdec -export script /tmp/hmi/supp hmi/MainSupplement.swf
```

Przydatne miejsca:

- `supp/scripts/peripheral/Peripheral.as` — manifest modułów i bramki bootu.
- `supp/scripts/com/{harman,nfuzion}/moduleLink/*.as` — implementacje modułów
  (kształty wiadomości, `isReady()`, nazwy `Dest`).
- `main/scripts/Main.as`, `Global.as` — start aplikacji, `hmiVars`.
- `supp/scripts/com/harman/moduleLinkAPI/*.as` — interfejsy/stałe.

## Załącznik D — co dalej (kolejność pracy)

1. Etap 0 (harness) — żeby każdy kolejny krok był mierzalny.
2. Etap 1 — odhaczyć boot, commit „booting”.
3. Etap 2 → 3 (Settings, potem HVAC) — pierwsze w pełni używalne ekrany.
4. Dalej wg tabeli w rozdziale 6, po jednym etapie = jeden commit.

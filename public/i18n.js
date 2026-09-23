// i18n.js — UI language. Keys are the Polish source strings; EN holds translations.
// t('…') returns the key itself in Polish, the translation in English; missing keys fall back to Polish
// (test/i18n.test.mjs fails when a key used in app.js or index.html has no English entry).

export const LANG_KEY = 'greenly.lang';
export const LANGS = ['pl', 'en'];

function detect() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.languages?.[0] || navigator.language || '').toLowerCase();
  return nav.startsWith('pl') ? 'pl' : 'en'; // Polish browsers get Polish, everyone else English
}

export const lang = detect();
document.documentElement.lang = lang;

export function setLang(next) {
  if (!LANGS.includes(next)) return;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
}

export function t(key, vars) {
  let s = lang === 'en' ? (EN[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

/** "3 dni" / "3 days" — pl forms: [1, 2–4, 5+]; en: [1, many]. */
export function plural(n, pl, en) {
  n = Math.abs(Number(n) || 0);
  if (lang === 'en') return n === 1 ? en[0] : en[1];
  if (n === 1) return pl[0];
  const m10 = n % 10; const m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14) ? pl[1] : pl[2];
}

export const locale = lang === 'en' ? 'en-GB' : 'pl-PL';

/** Translates static markup: [data-t] → textContent, [data-t-html] → innerHTML, [data-t-attr="attr"] → that attribute. */
export function translateDom(root = document) {
  if (lang !== 'en') return;
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-t-html]')) el.innerHTML = t(el.dataset.tHtml);
  for (const el of root.querySelectorAll('[data-t-attr]')) {
    const attr = el.dataset.tAttr;
    el.setAttribute(attr, t(el.getAttribute(attr)));
  }
}

export const EN = {
  // conditions
  'Terakota / glina niepolewana — szybko wysycha': 'Terracotta / unglazed clay — dries fast',
  'Ceramika szkliwiona': 'Glazed ceramic',
  'Plastik z otworami (także w osłonce)': 'Plastic with drainage holes (also inside a cachepot)',
  'Bez otworów odpływowych — woda nie odpływa': 'No drainage holes — water stays in',
  'Pełne słońce — parapet S/W, słońce na liściach': 'Full sun — south/west sill, sun on the leaves',
  'Jasno, bez ostrego słońca — przy oknie E/N': 'Bright, no harsh sun — by an east/north window',
  'Półcień — 1–2 m od okna': 'Partial shade — 1–2 m from a window',
  'Ciemny kąt — daleko od okna': 'Dark corner — far from a window',
  'profil gatunku': 'species profile', 'profil rodzaju': 'genus profile', 'profil rodziny': 'family profile', 'profil uniwersalny': 'generic profile',
  // validation + api
  'Wpisz login.': 'Enter your login.', 'Wpisz hasło.': 'Enter your password.',
  '3–32 znaki: litery, cyfry, kropka, myślnik lub podkreślenie.': '3–32 characters: letters, digits, dot, dash or underscore.',
  'Hasło musi mieć co najmniej 8 znaków.': 'The password needs at least 8 characters.',
  'Wpisz kod zaproszenia.': 'Enter the invite code.', 'Wpisz obecne hasło.': 'Enter your current password.',
  'Brak połączenia z serwerem.': 'No connection to the server.',
  'Sesja wygasła — zaloguj się ponownie.': 'Session expired — please log in again.',
  'Błąd {n}': 'Error {n}',
  // menu
  'administrator': 'administrator', 'użytkownik': 'user', 'Odświeżam…': 'Refreshing…',
  'Witaj, {name}!': 'Welcome, {name}!',
  // list + status
  'Brak daty podlania': 'No watering date', 'Odłożone · za': 'Postponed · in', 'Za': 'In', 'Dziś': 'Today',
  'Spóźnione o {n}': 'Overdue by {n}', 'co {n}': 'every {n}', 'ok. {ml} ml': 'approx. {ml} ml',
  'Wilgotność {pct}%': 'Moisture {pct}%', 'Podlej': 'Water', 'Cofnij · {s}': 'Undo · {s}',
  'Cofnięto podlanie.': 'Watering undone.', 'Podlano: {name}': 'Watered: {name}',
  // add / edit
  'Nowa roślina': 'New plant', 'Zrób zdjęcie / wybierz z galerii': 'Take a photo / pick from gallery',
  'Zdjęcie rośliny': 'Plant photo', 'Podgląd zdjęcia': 'Photo preview', 'albo': 'or',
  'Wpiszę nazwę sam, np. Monstera deliciosa': 'I’ll type the name, e.g. Monstera deliciosa',
  'Nazwa łacińska lub potoczna': 'Latin or common name', 'Dalej': 'Next',
  'Przygotowuję zdjęcie…': 'Preparing the photo…', 'Rozpoznaję przez Pl@ntNet…': 'Identifying with Pl@ntNet…',
  'Wybierz właściwe trafienie:': 'Pick the right match:', 'Brak trafień — wpisz nazwę ręcznie.': 'No matches — type the name.',
  'Możesz wpisać nazwę ręcznie poniżej.': 'You can type the name below.',
  'Edycja rośliny': 'Edit plant', 'Zmień zdjęcie': 'Change photo', 'Dodaj zdjęcie': 'Add photo', 'Usuń zdjęcie': 'Remove photo',
  'w tych warunkach, o tej porze roku': 'in these conditions, at this time of year',
  'Nazwa własna': 'Nickname', 'Średnica doniczki': 'Pot diameter', 'Doniczka': 'Pot', 'Światło': 'Light',
  'Liczy się doniczka, w której są korzenie. Osłonka nie ma znaczenia — chyba że po podlaniu zostaje w niej woda, wtedy wybierz „bez otworów”.':
    'What counts is the pot the roots are in. A decorative cachepot doesn’t matter — unless water stays in it after watering; then pick “no drainage holes”.',
  'Suche powietrze / blisko grzejnika': 'Dry air / near a radiator', 'Ostatnie podlanie': 'Last watered', 'Notatka': 'Note',
  'Usuń': 'Delete', 'Zapisz zmiany': 'Save changes', 'Dodaj roślinę': 'Add plant', 'Nie udało się przetworzyć zdjęcia.': 'Could not process the photo.',
  'Zapisano.': 'Saved.', 'Dodano roślinę.': 'Plant added.', 'Usunąć „{name}”?': 'Delete “{name}”?', 'Usunięto.': 'Deleted.',
  // push
  'Service worker nie jest aktywny. Zamknij aplikację całkowicie, otwórz ponownie i spróbuj jeszcze raz.': 'The service worker is not active. Close the app completely, open it again and retry.',
  'wł.': 'on', 'wył.': 'off', 'po instalacji': 'after install', 'brak': 'n/a',
  'Na iPhonie dodaj greenLy do ekranu początkowego i włącz powiadomienia z ikony.': 'On iPhone add greenLy to the Home Screen and enable notifications from the icon.',
  'Ta przeglądarka nie obsługuje powiadomień push.': 'This browser does not support push notifications.',
  'Serwer nie ma skonfigurowanych kluczy VAPID.': 'The server has no VAPID keys configured.',
  'Brak zgody na powiadomienia.': 'Notification permission denied.',
  'Powiadomienia wyłączone.': 'Notifications off.', 'Powiadomienia włączone.': 'Notifications on.',
  // plant view
  'W porządku': 'Fine', 'Obserwuj': 'Watch', 'Wymaga działania': 'Needs action',
  'niska pewność': 'low confidence', 'średnia pewność': 'medium confidence', 'wysoka pewność': 'high confidence',
  'Kontrola': 'Check-up', 'Doktor': 'Doctor', 'Rośliny': 'Plants', 'Edytuj': 'Edit', '+ Zdarzenie': '+ Event', 'Rozsadź': 'Divide',
  'Warunki': 'Conditions', 'Jak dbać': 'Care', 'Historia': 'History', 'Powiększ zdjęcie': 'Enlarge photo',
  'Zamiast porcji: <b>zanurz doniczkę</b> w letniej wodzie na 10–15 min, potem odsącz.': 'Instead of a portion: <b>soak the pot</b> in lukewarm water for 10–15 min, then drain.',
  'Na raz ok. <b>{ml} ml</b> — aż woda pokaże się w podstawce, nadmiar wylej.': 'About <b>{ml} ml</b> per watering — until water shows in the saucer, then pour off the excess.',
  'Nauczone z „Nadal mokro”: porcja ×{ml}, interwał ×{iv}': 'Learned from “Still wet”: portion ×{ml}, interval ×{iv}',
  '↓ dopasowane': '↓ adjusted', 'Nadal mokro': 'Still wet',
  'Powietrze': 'Air', 'suche / grzejnik w pobliżu': 'dry / radiator nearby', 'normalne': 'normal', 'Podlewanie': 'Watering',
  'o tej porze roku': 'at this time of year', 'faktycznie średnio co {n}': 'actually every {n} on average',
  'Jak dbać — {label}': 'Care — {label}', 'Wilgotność': 'Humidity', 'Temperatura': 'Temperature', 'Gdzie postawić': 'Placement',
  'Profil gatunku': 'Species profile',
  'Szczegółowy opis gatunku napisany przez AI: pochodzenie, światło, podlewanie, nawożenie, przesadzanie, toksyczność dla zwierząt, typowe problemy.':
    'A detailed species profile written by AI: origin, light, watering, feeding, repotting, pet toxicity, common problems.',
  'Opisz gatunek': 'Describe species', 'Analizy': 'Analyses',
  'Jeszcze żadnej. „Kontrola” ocenia ogólny stan i warunki, „Doktor” szuka przyczyny konkretnego problemu.': 'None yet. “Check-up” rates overall condition and setup, “Doctor” hunts for the cause of a specific problem.',
  'Wszystko': 'All', 'Zabiegi': 'Care', 'Podlewania': 'Waterings', 'Nic tu jeszcze nie ma.': 'Nothing here yet.',
  'Usunąć: {title} ({when})?': 'Delete: {title} ({when})?',
  // snooze
  'Nadal mokro: {name}': 'Still wet: {name}', 'Nie podlewaj': 'Don’t water',
  'dopóki 2–3 cm podłoża pod powierzchnią nie przeschną. Sprawdź palcem albo patyczkiem.': 'until the top 2–3 cm of soil dry out. Check with a finger or a stick.',
  'Storczyk: moczysz doniczkę zamiast lać porcję, więc': 'Orchid: you soak the pot instead of pouring a portion, so',
  'Plan zakłada ok. <b>{ml} ml</b> na raz przy tej doniczce. Jeśli ziemia jest mokra po tylu dniach,': 'The plan assumes about <b>{ml} ml</b> per watering for this pot. If the soil is still wet after that many days,',
  'przy następnym podlaniu': 'next time', 'skróć moczenie': 'soak for less time', 'wlej mniej': 'pour less',
  'albo sprawdź, czy w osłonce nie stoi woda.': 'or check whether water is standing in the cachepot.',
  'Przypomnę ponownie za:': 'Remind me again in:', 'Notatka (opcjonalnie)': 'Note (optional)',
  'np. osłonka była pełna wody': 'e.g. the cachepot was full of water',
  'Odłożenie trafia do historii. Gdy powtórzy się w tym samym cyklu albo dwa cykle z rzędu, greenLy sam zmniejszy porcję o 15 % i wydłuży interwał o 10 % dla tej rośliny; trzy spokojne cykle przywracają normę.':
    'The snooze goes into the history. When it repeats within one cycle or in two cycles in a row, greenLy cuts this plant’s portion by 15 % and stretches its interval by 10 %; three calm cycles restore the defaults.',
  'Teraz: porcja ×{ml}, interwał ×{iv}.': 'Now: portion ×{ml}, interval ×{iv}.',
  'Przypomnę za {n}.': 'I’ll remind you in {n}.',
  'Przypomnę za {n}. Ta roślina dostaje mniej: {portion}, co {every}.': 'I’ll remind you in {n}. This plant now gets less: {portion}, every {every}.',
  'krótsze moczenie': 'a shorter soak',
  // profile / checks
  'Pochodzenie': 'Origin', 'Podłoże i doniczka': 'Soil and pot', 'Nawożenie': 'Feeding', 'Przesadzanie': 'Repotting', 'Zwierzęta': 'Pets',
  'Typowe problemy:': 'Common problems:', 'Napisz od nowa': 'Rewrite', 'Opis gotowy.': 'Profile ready.',
  'Co zrobić:': 'What to do:', 'Podlewanie:': 'Watering:', 'Analiza': 'Analysis', 'dopytanie': 'follow-up', 'pyta': 'asks',
  'Pytania (odpowiedziano)': 'Questions (answered)', 'Doktor pyta:': 'The Doctor asks:', 'Odpowiedz po kolei…': 'Answer one by one…',
  'Odpowiedz i zaktualizuj diagnozę': 'Answer and update the diagnosis', 'tokenów': 'tokens', 'Zamknij': 'Close',
  'Diagnoza zaktualizowana.': 'Diagnosis updated.',
  // thinking
  'zwykle ok. {est} s': 'usually about {est} s', 'minęło {s} s · zwykle ok. {est} s': '{s} s elapsed · usually about {est} s',
  'minęło {s} s · trwa dłużej niż zwykle, model dokładnie ogląda zdjęcia': '{s} s elapsed · taking longer than usual, the model is studying the photos',
  'Oglądam zdjęcia': 'Looking at the photos', 'Sprawdzam liście i ich kolor': 'Checking the leaves and their colour', 'Patrzę na końcówki i brzegi liści': 'Looking at leaf tips and edges',
  'Szukam plam, przebarwień i śladów szkodników': 'Looking for spots, discolouration and pests', 'Oceniam turgor — czy liście są jędrne': 'Assessing turgor — are the leaves firm',
  'Porównuję z warunkami, w jakich stoi': 'Comparing with its conditions', 'Sprawdzam, czy światło pasuje do gatunku': 'Checking whether the light suits the species',
  'Zerkam na doniczkę i podłoże': 'Glancing at the pot and soil', 'Sprawdzam rytm podlewania i porę roku': 'Checking the watering rhythm and season',
  'Liczę, ile dni minęło od podlania': 'Counting days since the last watering', 'Zestawiam z tym, co lubi ten gatunek': 'Matching against what this species likes',
  'Przeglądam ostatnie zdarzenia w historii': 'Reviewing recent history', 'Zastanawiam się nad nawożeniem': 'Thinking about feeding',
  'Sprawdzam, czy nie czas na przesadzenie': 'Checking whether it’s time to repot', 'Oceniam wilgotność powietrza wokół rośliny': 'Assessing the humidity around the plant',
  'Układam zalecenia od najważniejszego': 'Ordering advice by importance', 'Dobieram wskazówki do Twojego mieszkania': 'Tailoring tips to your home',
  'Sprawdzam, czy niczego nie przeoczyłem': 'Checking I haven’t missed anything', 'Redaguję ocenę': 'Writing up the assessment', 'Jeszcze chwila, dopinam szczegóły': 'One moment, polishing details',
  'Czytam Twój opis': 'Reading your description', 'Szukam objawów na liściach': 'Looking for symptoms on the leaves', 'Sprawdzam spód liści i łodygi': 'Checking leaf undersides and stems',
  'Przyglądam się podłożu': 'Examining the soil', 'Zestawiam objawy z Twoim opisem': 'Matching symptoms with your description', 'Ważę możliwe przyczyny': 'Weighing possible causes',
  'Sprawdzam, czy to przelanie': 'Checking for overwatering', 'Sprawdzam, czy to przesuszenie': 'Checking for underwatering', 'Rozważam szkodniki': 'Considering pests',
  'Rozważam grzyby i bakterie': 'Considering fungi and bacteria', 'Sprawdzam, czy winne jest światło': 'Checking whether light is to blame', 'Sprawdzam, czy winne jest suche powietrze': 'Checking whether dry air is to blame',
  'Porównuję z historią podlewania': 'Comparing with the watering history', 'Szeregują hipotezy od najbardziej prawdopodobnej': 'Ranking hypotheses by likelihood',
  'Zastanawiam się, co sprawdzić palcem w doniczce': 'Deciding what to check with a finger in the pot', 'Sprawdzam, czego brakuje do diagnozy': 'Checking what’s missing for a diagnosis',
  'Układam pytania, jeśli są potrzebne': 'Drafting questions if needed', 'Układam plan działania': 'Drafting an action plan', 'Wybieram, co zrobić od razu': 'Choosing what to do right away', 'Redaguję diagnozę': 'Writing up the diagnosis',
  'Czytam odpowiedzi': 'Reading your answers', 'Wracam do zdjęć': 'Going back to the photos', 'Zestawiam odpowiedzi z objawami': 'Matching answers with symptoms',
  'Wykluczam, co się nie zgadza': 'Ruling out what doesn’t fit', 'Sprawdzam, która hipoteza została': 'Checking which hypothesis is left', 'Aktualizuję diagnozę': 'Updating the diagnosis',
  'Sprawdzam, co jeszcze wykluczyć': 'Checking what else to rule out', 'Przeliczam ryzyko przelania': 'Recalculating the overwatering risk', 'Sprawdzam, czy pasuje do gatunku': 'Checking it fits the species',
  'Weryfikuję plan działania': 'Verifying the action plan', 'Zastanawiam się, czy potrzebne są kolejne pytania': 'Considering whether more questions are needed', 'Doprecyzowuję zalecenia': 'Refining the advice', 'Redaguję odpowiedź': 'Writing the reply',
  'Przypominam sobie gatunek': 'Recalling the species', 'Sprawdzam, skąd pochodzi': 'Checking where it comes from', 'Sprawdzam wymagania świetlne': 'Checking light requirements',
  'Dobieram rytm podlewania do polskiego mieszkania': 'Tuning the watering rhythm to a heated flat', 'Myślę o zimie z grzejnikiem pod parapetem': 'Thinking about winter with a radiator under the sill',
  'Sprawdzam wilgotność, jaką lubi': 'Checking the humidity it likes', 'Sprawdzam zakres temperatur': 'Checking the temperature range', 'Dobieram podłoże i doniczkę': 'Choosing soil and pot',
  'Ustalam, jak i kiedy nawozić': 'Working out how and when to feed', 'Ustalam, kiedy przesadzać': 'Working out when to repot', 'Sprawdzam, czy jest bezpieczna dla kotów i psów': 'Checking if it’s safe for cats and dogs',
  'Spisuję typowe problemy': 'Listing common problems', 'Zestawiam z warunkami, w których stoi': 'Matching against its conditions', 'Szukam, gdzie najlepiej ją postawić': 'Finding the best spot for it',
  'Skracam do konkretów': 'Trimming to the essentials', 'Redaguję opis': 'Writing the profile',
  // events
  'Przesadzenie': 'Repotting', 'nowa doniczka lub podłoże': 'new pot or soil', 'Rozsadzenie': 'Division', 'podział na dwie rośliny': 'split into two plants',
  'Przestawienie': 'Moved', 'nowe miejsce, inne światło': 'new spot, different light', 'czym i ile': 'what and how much',
  'Przycięcie': 'Pruning', 'formowanie, usunięte liście': 'shaping, removed leaves', 'Zabieg / oprysk': 'Treatment / spray', 'szkodniki, grzyb': 'pests, fungus',
  'Prysznic / zraszanie': 'Shower / misting', 'mycie liści': 'washing the leaves', 'Kwitnienie': 'Blooming', 'obserwacja': 'observation',
  'Nowy przyrost': 'New growth', 'liść, pęd, korzeń': 'leaf, shoot, root', 'cokolwiek innego': 'anything else', 'Odłożone podlanie': 'Watering postponed',
  'terakota': 'terracotta', 'ceramika': 'ceramic', 'plastik': 'plastic', 'bez odpływu': 'no drainage',
  'pełne słońce': 'full sun', 'jasno': 'bright', 'półcień': 'partial shade', 'ciemny kąt': 'dark corner', 'suche powietrze': 'dry air',
  'odłączona od': 'divided from', 'oddzielono': 'split off', 'podlana przy okazji': 'watered at the same time',
  'nadal mokro · o {n}': 'still wet · by {n}', 'do {date}': 'until {date}', 'porcja −15 %, interwał +10 %': 'portion −15 %, interval +10 %',
  'Podlanie': 'Watering', 'Dodano do greenLy': 'Added to greenLy', 'czeka na odpowiedź': 'awaiting your answer',
  'Zdarzenie: {name}': 'Event: {name}', 'Nowa średnica doniczki': 'New pot diameter', 'Światło w nowym miejscu': 'Light in the new spot',
  'Treść': 'Text', 'np. Biohumus 1:20': 'e.g. seaweed feed 1:20', 'np. mydło potasowe na przędziorki': 'e.g. insecticidal soap for spider mites',
  'Data': 'Date', 'Przy okazji podlana': 'Watered at the same time', 'Wstecz': 'Back', 'Zapisano: {label}.': 'Saved: {label}.',
  '✂️ Rozsadzenie: {name}': '✂️ Division: {name}',
  'Powstanie druga roślina tego samego gatunku z tymi samymi warunkami — poniżej ustaw jej nazwę i doniczkę. Obie dostaną wpis w historii. Doniczkę tej rośliny zmienisz osobno w „Edytuj” lub przez „Przesadzenie”.':
    'A second plant of the same species with the same conditions will be created — set its name and pot below. Both get a history entry. Change this plant’s pot separately via “Edit” or “Repotting”.',
  'Zdjęcie nowej rośliny': 'Photo of the new plant', 'Nazwa nowej rośliny': 'Name of the new plant', 'Średnica jej doniczki': 'Its pot diameter',
  'Obie podlane przy rozsadzaniu': 'Both watered when dividing', 'Utworzono „{name}”.': 'Created “{name}”.',
  // check-up
  'Doktor: {name}': 'Doctor: {name}', 'Kontrola: {name}': 'Check-up: {name}',
  'Zrób wyraźne zdjęcie problematycznego miejsca (liść z bliska, łodyga, podłoże) i opisz, co Cię niepokoi. Jeśli do diagnozy zabraknie informacji, Doktor zada pytania.':
    'Take a clear photo of the problem area (a leaf up close, the stem, the soil) and describe what worries you. If something is missing for a diagnosis, the Doctor will ask.',
  'Zrób zdjęcie całej rośliny w naturalnym świetle. Ocena obejmie stan liści, dopasowanie światła, doniczki i podlewania.':
    'Take a photo of the whole plant in natural light. The check covers the leaves and how well light, pot and watering fit.',
  'Zdjęcia (do 4)': 'Photos (up to 4)', 'Możesz dodać do 4 zdjęć — np. cała roślina, chory liść z bliska, podłoże.': 'You can add up to 4 photos — e.g. the whole plant, a sick leaf up close, the soil.',
  'Co Cię niepokoi?': 'What worries you?', 'Uwagi (opcjonalnie)': 'Remarks (optional)',
  'np. od tygodnia żółkną dolne liście, na spodzie białe kropki': 'e.g. lower leaves yellowing for a week, white dots underneath', 'np. przesadzona 2 tygodnie temu': 'e.g. repotted two weeks ago',
  'Postaw diagnozę': 'Diagnose', 'Sprawdź stan': 'Check condition',
  'Analiza trwa 15–60 s i kosztuje kilka–kilkanaście groszy za zdjęcie (Claude, płatność za użycie).': 'An analysis takes 15–60 s and costs a few cents per photo (Claude, pay per use).',
  'Dodaj kolejne zdjęcie ({n}/{max})': 'Add another photo ({n}/{max})', 'Doktor myśli…': 'The Doctor is thinking…', 'Sprawdzam…': 'Checking…',
  // install
  'greenLy zainstalowane — otwórz aplikację z ikony.': 'greenLy installed — open it from the icon.',
  'iPhone / iPad': 'iPhone / iPad', 'Komputer': 'Desktop',
  'Stuknij <b>Udostępnij</b> {where}.': 'Tap <b>Share</b> {where}.', 'w menu Chrome (ikona ze strzałką w górę)': 'in the Chrome menu (the arrow-up icon)',
  '(kwadrat ze strzałką w górę na dolnym pasku Safari)': '(the square with an arrow on Safari’s bottom bar)',
  'Przewiń listę i wybierz <b>Do ekranu początkowego</b>.': 'Scroll the list and pick <b>Add to Home Screen</b>.',
  'Stuknij <b>Dodaj</b> w prawym górnym rogu.': 'Tap <b>Add</b> in the top right corner.',
  'Otwieraj greenLy <b>z ikony</b> na ekranie początkowym i tam włącz powiadomienia.': 'Open greenLy <b>from the icon</b> on your Home Screen and enable notifications there.',
  'Stuknij <b>⋮</b> (menu Chrome) w prawym górnym rogu.': 'Tap <b>⋮</b> (Chrome menu) in the top right corner.',
  'Wybierz <b>Zainstaluj aplikację</b> albo <b>Dodaj do ekranu głównego</b>.': 'Choose <b>Install app</b> or <b>Add to Home screen</b>.',
  'Potwierdź. Otwieraj greenLy z ikony.': 'Confirm. Open greenLy from the icon.',
  'Chrome / Edge: kliknij ikonę instalacji po prawej stronie paska adresu albo <b>⋮ → Zainstaluj greenLy</b>.': 'Chrome / Edge: click the install icon on the right of the address bar or <b>⋮ → Install greenLy</b>.',
  'Safari (macOS): <b>Plik → Dodaj do Docka</b>.': 'Safari (macOS): <b>File → Add to Dock</b>.',
  'Na telefonie otwórz ten sam adres i dodaj greenLy do ekranu początkowego — tam działają powiadomienia.': 'On your phone open the same address and add greenLy to the Home Screen — notifications work there.',
  'Zainstaluj greenLy': 'Install greenLy', 'Ta strona jest aplikacją — najlepiej działa z ekranu początkowego.': 'This page is an app — it works best from your Home Screen.',
  '<b>Przypomnienia o podlewaniu</b> przychodzą tylko do zainstalowanej aplikacji{ios}.': '<b>Watering reminders</b> only reach the installed app{ios}.',
  ' (na iPhonie w przeglądarce nie działają wcale)': ' (on iPhone they don’t work in the browser at all)',
  'Pełny ekran, własna ikona, działa offline.': 'Full screen, its own icon, works offline.', 'Zainstaluj teraz': 'Install now',
  'Rozumiem, że bez instalacji nie dostanę przypomnień, i chcę używać greenLy w przeglądarce.': 'I understand I won’t get reminders without installing, and I want to use greenLy in the browser.',
  'Używaj w przeglądarce': 'Use in the browser',
  // no key
  'Jeszcze chwila': 'One moment', 'Rozumiem': 'Got it',
  'Administrator przypisał Ci wspólny klucz Claude, ale jeszcze go nie ustawił. Gdy to zrobi, Kontrola, Doktor i opisy gatunków zaczną działać same — nic nie musisz robić.':
    'The administrator assigned you the shared Claude key but hasn’t set it yet. Once they do, Check-up, Doctor and species profiles will just work — nothing to do on your side.',
  'Siemano! Tu potrzebny jest Twój klucz Claude': 'Hey! This needs your Claude key',
  'Kontrola, Doktor i opisy gatunków to analizy robione przez Claude (AI od Anthropic). Żeby z nich korzystać, podepnij w ustawieniach konta <b>własny klucz API</b>. Rozliczasz się bezpośrednio z Anthropic, greenLy nic nie dolicza.':
    'Check-up, Doctor and species profiles are analyses done by Claude (Anthropic’s AI). To use them, add <b>your own API key</b> in account settings. You pay Anthropic directly; greenLy adds nothing.',
  'Płacisz z góry doładowanymi kredytami, bez abonamentu. Jedna analiza ze zdjęciem to zwykle <b>3–8 centów</b> na Claude Opus 5 albo <b>2–3 centy</b> na Sonnet 5.':
    'You pay with prepaid credits, no subscription. One analysis with a photo is usually <b>3–8 cents</b> on Claude Opus 5 or <b>2–3 cents</b> on Sonnet 5.',
  '<b>5 $</b> wystarcza mniej więcej na <b>60–150 analiz</b> na Opus 5 albo <b>około 200</b> na Sonnet 5. Nowe konto Anthropic dostaje też małą pulę darmowych kredytów na start.':
    '<b>$5</b> covers roughly <b>60–150 analyses</b> on Opus 5 or <b>about 200</b> on Sonnet 5. A new Anthropic account also gets a small pool of free credits to start.',
  'Klucz jest szyfrowany na serwerze i nigdy nie wraca do przeglądarki. W Koncie masz instrukcję krok po kroku, jak go założyć.': 'The key is encrypted on the server and never sent back to the browser. The Account screen has a step-by-step guide to creating one.',
  'Podłącz klucz w Koncie': 'Add the key in Account', 'Może później': 'Maybe later',
  // key how-to
  'Jak założyć klucz Claude — krok po kroku': 'How to create a Claude key — step by step',
  'Wejdź na <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> (Claude Console) i zaloguj się albo załóż konto — mail lub konto Google.':
    'Go to <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> (Claude Console) and sign in or create an account — email or Google.',
  'Doładuj kredyty: <b>Settings → Billing → Buy credits</b>, wpisz kwotę (np. 5 $) i zapłać kartą. Bez kredytów API nie odpowiada; nowe konto ma małą darmową pulę na start. Kredyty są ważne rok. W sekcji <b>Auto-reload</b> możesz włączyć automatyczne doładowanie.':
    'Buy credits: <b>Settings → Billing → Buy credits</b>, enter an amount (e.g. $5) and pay by card. Without credits the API doesn’t respond; a new account has a small free pool. Credits are valid for a year. Under <b>Auto-reload</b> you can enable automatic top-ups.',
  'Otwórz <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Settings → API keys</a> i kliknij <b>Create key</b>.': 'Open <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Settings → API keys</a> and click <b>Create key</b>.',
  'Nadaj nazwę (np. <i>greenLy</i>), wybierz ważność (<i>expiration</i>) i zostaw <b>Linked account</b> ustawione na siebie. Zatwierdź.': 'Name it (e.g. <i>greenLy</i>), pick an expiration and leave <b>Linked account</b> set to yourself. Confirm.',
  'Skopiuj klucz — zaczyna się od <code>sk-ant-</code> i Console pokaże go <b>tylko raz</b>. Jeśli go zgubisz, po prostu utwórz nowy.': 'Copy the key — it starts with <code>sk-ant-</code> and the Console shows it <b>only once</b>. If you lose it, just create a new one.',
  'Wklej go tutaj i kliknij <b>Zapisz</b>. greenLy sprawdzi klucz w Anthropic zanim go zapisze.': 'Paste it here and click <b>Save</b>. greenLy verifies the key with Anthropic before storing it.',
  'Koszty: Opus 5 to 5 $ za milion tokenów wejścia i 25 $ za milion wyjścia, Sonnet 5 odpowiednio 2 $ i 10 $. Jedna analiza ze zdjęciem to 3–8 centów (Opus) albo 2–3 centy (Sonnet); opis gatunku jest tańszy. Zużycie widać w Console w zakładce <b>Usage</b>, a przybliżony koszt każdej analizy pod jej wynikiem w greenLy.':
    'Costs: Opus 5 is $5 per million input tokens and $25 per million output, Sonnet 5 is $2 and $10. One analysis with a photo is 3–8 cents (Opus) or 2–3 cents (Sonnet); a species profile is cheaper. Usage is shown in the Console under <b>Usage</b>, and the approximate cost of each analysis under its result in greenLy.',
  // account
  'Claude Opus 5 — najdokładniejszy': 'Claude Opus 5 — most thorough', 'Claude Sonnet 5 — tańszy': 'Claude Sonnet 5 — cheaper',
  'niski — szybko i tanio': 'low — fast and cheap', 'średni — domyślny': 'medium — default', 'wysoki — wnikliwie, drożej': 'high — thorough, pricier',
  'Konto': 'Account', 'Zalogowano jako': 'Logged in as', 'Klucz Anthropic (Claude)': 'Anthropic key (Claude)',
  'Na Twoje konto jest przypisany globalny klucz Claude': 'A global Claude key is assigned to your account',
  'Administrator przypisał Ci globalny klucz, ale nie jest jeszcze ustawiony — analizy AI są wyłączone': 'The administrator assigned you the global key, but it isn’t set yet — AI analyses are off',
  'Kontrola, Doktor i opisy gatunków działają na kluczu administratora i nie obciążają Twojego konta Anthropic. Model: <b>{model}</b> · dokładność: <b>{effort}</b>. Własnego klucza nie ustawisz — o zmianę poproś administratora.':
    'Check-up, Doctor and species profiles run on the administrator’s key and don’t charge your Anthropic account. Model: <b>{model}</b> · effort: <b>{effort}</b>. You can’t set your own key — ask the administrator for changes.',
  'Kontrola, Doktor i opisy gatunków działają na Twoim własnym kluczu i obciążają Twoje konto Anthropic (kilka centów za analizę). Klucz jest szyfrowany na serwerze i nigdy nie wraca do przeglądarki.':
    'Check-up, Doctor and species profiles run on your own key and charge your Anthropic account (a few cents per analysis). The key is encrypted on the server and never sent back to the browser.',
  'Klucz ustawiony': 'Key set', 'kończy się na …{hint}': 'ends with …{hint}', 'Brak klucza — analizy AI są wyłączone': 'No key — AI analyses are off',
  'Nowy klucz (zostaw puste, żeby nie zmieniać)': 'New key (leave empty to keep the current one)', 'Klucz API': 'API key',
  'Model': 'Model', 'Dokładność': 'Effort', 'Usuń klucz': 'Remove key', 'Zapisz': 'Save',
  'Hasło': 'Password', 'Obecne hasło': 'Current password', 'Nowe hasło (min. 8 znaków)': 'New password (min. 8 characters)', 'Zmień hasło': 'Change password',
  'Aplikacja': 'App', 'Używasz zainstalowanej aplikacji. 👍': 'You’re using the installed app. 👍',
  'Używasz greenLy w przeglądarce — przypomnienia działają dopiero po instalacji.': 'You’re using greenLy in the browser — reminders only work after installing.',
  'Jak zainstalować': 'How to install', 'Odśwież aplikację': 'Refresh the app', 'Administracja': 'Administration',
  'Użytkownicy, kody zaproszeń, resetowanie haseł.': 'Users, invite codes, password resets.', 'Otwórz panel administratora': 'Open the admin panel', 'Wyloguj': 'Log out',
  'Język': 'Language', 'Polski': 'Polish', 'English': 'English',
  'Klucz Anthropic zaczyna się od sk-ant-…': 'An Anthropic key starts with sk-ant-…', 'Sprawdzam klucz…': 'Checking the key…', 'Zapisuję…': 'Saving…',
  'Klucz działa — analizy AI włączone.': 'The key works — AI analyses enabled.',
  'Usunąć klucz? Analizy AI przestaną działać do czasu dodania nowego.': 'Remove the key? AI analyses stop working until you add a new one.', 'Klucz usunięty.': 'Key removed.',
  'Hasło zmienione. Inne urządzenia zostały wylogowane.': 'Password changed. Other devices have been logged out.',
  // admin
  'przed chwilą': 'just now', '{n} h temu': '{n} h ago', '{n} temu': '{n} ago', 'nigdy': 'never',
  'globalny': 'global', 'globalny (nieustawiony)': 'global (not set)', 'własny': 'own',
  '(ty)': '(you)', 'admin': 'admin', 'klucz AI': 'AI key', 'powiadomienia': 'notifications', 'ostatnio': 'last seen', 'kod': 'code',
  'Globalny klucz: wł.': 'Global key: on', 'Przypisz globalny klucz': 'Assign global key', 'Odbierz admina': 'Revoke admin', 'Nadaj admina': 'Make admin',
  'użyto {u}/{m}': 'used {u}/{m}', 'wyłączony': 'disabled', 'Kopiuj': 'Copy', 'Włącz': 'Enable', 'Wyłącz': 'Disable',
  'Globalny klucz Claude': 'Global Claude key',
  'Jeden klucz dla wybranych użytkowników: analizy idą na Twoje konto Anthropic. Komu go przypiszesz (przycisk przy użytkowniku), ten nie może ustawić własnego klucza i widzi informację, że korzysta z globalnego.':
    'One key for chosen users: their analyses charge your Anthropic account. Whoever you assign it to (button next to the user) can’t set their own key and sees a note that they use the global one.',
  'Brak globalnego klucza': 'No global key', 'Kody zaproszeń': 'Invite codes', 'Dla kogo (notatka)': 'For whom (note)', 'np. Ola': 'e.g. Anna', 'Ile użyć': 'Uses',
  'Wygeneruj kod': 'Generate code', 'Dodatkowo działa stały kod z config.js (bez limitu użyć).': 'The permanent code from config.js also works (unlimited uses).',
  'Brak kodów — wygeneruj pierwszy.': 'No codes — generate the first one.', 'Użytkownicy ({n})': 'Users ({n})', 'Wróć do konta': 'Back to account',
  'Globalny klucz działa.': 'The global key works.', 'Usunąć globalny klucz? Użytkownicy, którym jest przypisany, stracą analizy AI.': 'Remove the global key? Users assigned to it lose AI analyses.',
  'Globalny klucz usunięty.': 'Global key removed.', 'Kod: {code}': 'Code: {code}', 'Skopiowano kod.': 'Code copied.', 'Kod zaproszenia:': 'Invite code:',
  'Usunąć kod {code}?': 'Delete code {code}?',
  'Usunąć konto „{login}” razem ze wszystkimi roślinami i historią? Tego nie da się cofnąć.': 'Delete account “{login}” with all its plants and history? This cannot be undone.',
  'Nowe hasło dla „{login}” (min. 8 znaków). Użytkownik zostanie wylogowany ze wszystkich urządzeń.': 'New password for “{login}” (min. 8 characters). The user will be logged out everywhere.',
  'Hasło zmienione.': 'Password changed.', 'Konto usunięte.': 'Account deleted.',
  // static (index.html)
  'Start': 'Start', 'Logowanie': 'Log in', 'Rejestracja': 'Sign up', 'Powiadomienia': 'Notifications', '+ Dodaj roślinę': '+ Add plant',
  'Twoje rośliny doniczkowe, podlane na czas. Bez zgadywania.': 'Your houseplants, watered on time. No guesswork.',
  '<b>Zdjęcie zamiast atlasu.</b> Sfotografuj roślinę, a greenLy rozpozna gatunek i dobierze do niego plan podlewania.': '<b>A photo instead of a field guide.</b> Snap the plant and greenLy identifies the species and builds a watering plan for it.',
  '<b>Plan pod Twoje warunki.</b> Doniczka, światło, suche powietrze, pora roku: interwał i porcja wody liczą się z tego, gdzie roślina naprawdę stoi.': '<b>A plan for your conditions.</b> Pot, light, dry air, season: the interval and the amount of water come from where the plant actually lives.',
  '<b>Przypomnienia na telefon.</b> Powiadomienie w dniu podlania. Jeśli ziemia nadal mokra, jeden tap odkłada termin, a apka uczy się na tym.': '<b>Reminders on your phone.</b> A notification on watering day. Still wet? One tap postpones it, and the app learns from that.',
  '<b>Kontrola i Doktor.</b> Zdjęcie do Claude: ocena stanu, diagnoza problemu z dopytaniem, profil pielęgnacji gatunku. Na Twoim kluczu, za centy.': '<b>Check-up and Doctor.</b> A photo to Claude: condition rating, problem diagnosis with follow-up questions, a species care profile. On your own key, for cents.',
  '<b>Historia każdej rośliny.</b> Podlewania, przesadzenia, rozsadzanie, nawożenie, analizy: wszystko na jednej osi czasu.': '<b>Every plant’s history.</b> Waterings, repotting, division, feeding, analyses: all on one timeline.',
  'Załóż konto': 'Create account', 'Mam już konto': 'I have an account',
  'Aplikacja jest <b>bezpłatna</b>. Konta na zaproszenie. Zainstaluj greenLy na ekranie początkowym, żeby dostawać przypomnienia.': 'The app is <b>free</b>. Accounts are invite-only. Install greenLy on your Home Screen to get reminders.',
  'Właściciel tej instancji: <b>Szymon Halski</b> · <a href="mailto:greenly@freely.digital">greenly@freely.digital</a>': 'Owner of this instance: <b>Szymon Halski</b> · <a href="mailto:greenly@freely.digital">greenly@freely.digital</a>',
  'Open source: kod jest publiczny na <a href="https://github.com/halskiszymon/greenly" target="_blank" rel="noopener">github.com/halskiszymon/greenly</a>. Możesz postawić własną instancję. Chcesz kontrybuować? Zrób po prostu PR i merguj.':
    'Open source: the code is public at <a href="https://github.com/halskiszymon/greenly" target="_blank" rel="noopener">github.com/halskiszymon/greenly</a>. You can host your own instance. Want to contribute? Just open a PR and merge.',
  'Zaloguj się': 'Log in', 'Login': 'Login', 'Wejdź': 'Enter', 'Nie pamiętasz hasła?': 'Forgot your password?',
  'Hasła nie da się zresetować samemu. Napisz na <a href="mailto:greenly@freely.digital?subject=greenLy%20%E2%80%93%20reset%20has%C5%82a">greenly@freely.digital</a> albo bezpośrednio do Szymona: podaj swój login, a dostaniesz nowe hasło, które zmienisz w Koncie po zalogowaniu.':
    'Passwords can’t be reset on your own. Write to <a href="mailto:greenly@freely.digital?subject=greenLy%20%E2%80%93%20password%20reset">greenly@freely.digital</a> or directly to Szymon with your login, and you’ll get a new password to change in Account after logging in.',
  'Hasło (min. 8 znaków)': 'Password (min. 8 characters)', 'Kod zaproszenia': 'Invite code',
  'Każde konto ma własne rośliny i własny klucz Claude do analiz. Kod zaproszenia dostaniesz od osoby, która prowadzi tę instancję.': 'Each account has its own plants and its own Claude key for analyses. Ask the person running this instance for an invite code.',
  'Na iPhonie powiadomienia działają dopiero po dodaniu greenLy do ekranu początkowego (Udostępnij → „Do ekranu początkowego”). Zgodę na powiadomienia kliknij w wersji uruchomionej z ikony.':
    'On iPhone notifications only work after adding greenLy to the Home Screen (Share → “Add to Home Screen”). Grant notification permission in the version opened from the icon.',
  'Nie masz jeszcze roślin. Dodaj pierwszą ze zdjęcia.': 'No plants yet. Add the first one from a photo.',
  'Jest nowa wersja greenLy': 'A new version of greenLy is here',
  'Odśwież, żeby korzystać z aktualnej wersji. Zajmie to sekundę, nic nie stracisz.': 'Refresh to use the current version. It takes a second and nothing is lost.',
  'Odśwież teraz': 'Refresh now', 'Menu': 'Menu', 'greenLy — strona główna': 'greenLy — home', 'Panel administratora': 'Admin panel',
};

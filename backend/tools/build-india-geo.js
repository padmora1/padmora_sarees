// Builds the address data the shop uses from (a) tools/india-cities-source.js and (b) India Post's open pincode directory.
//   node tools/build-india-geo.js path/to/all-india-pincode-json-array.json
// (the directory is the Open Government Data "All India Pincode Directory"; it is only read here, not shipped.)
// It writes:
//   data/india-geo.json     states, cities per state, 3-digit pincode prefixes per state        (server)
//   data/india-pins.json    every known pincode -> its state                                     (server, loaded on first use)
//   ../frontend/js/india-geo.js   the same states / cities / prefixes for the browser            (checkout + account pages only)
// A curated city that no post office in that state carries is reported and left out, so a city is only ever listed under its own state.
const fs = require('fs');
const path = require('path');
const source = require('./india-cities-source');

const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];

// how the directory spells its states (older names) -> ours
const DIR_STATE = {
  'TELANGANA': 'Telangana', 'ANDHRA PRADESH': 'Andhra Pradesh', 'PONDICHERRY': 'Puducherry', 'ASSAM': 'Assam', 'BIHAR': 'Bihar',
  'CHATTISGARH': 'Chhattisgarh', 'DELHI': 'Delhi', 'GUJARAT': 'Gujarat', 'DAMAN & DIU': 'Dadra and Nagar Haveli and Daman and Diu',
  'DADRA & NAGAR HAVELI': 'Dadra and Nagar Haveli and Daman and Diu', 'HARYANA': 'Haryana', 'HIMACHAL PRADESH': 'Himachal Pradesh',
  'JAMMU & KASHMIR': 'Jammu and Kashmir', 'JHARKHAND': 'Jharkhand', 'KARNATAKA': 'Karnataka', 'KERALA': 'Kerala', 'LAKSHADWEEP': 'Lakshadweep',
  'MADHYA PRADESH': 'Madhya Pradesh', 'MAHARASHTRA': 'Maharashtra', 'GOA': 'Goa', 'MANIPUR': 'Manipur', 'MIZORAM': 'Mizoram', 'NAGALAND': 'Nagaland',
  'TRIPURA': 'Tripura', 'ARUNACHAL PRADESH': 'Arunachal Pradesh', 'MEGHALAYA': 'Meghalaya', 'ODISHA': 'Odisha', 'CHANDIGARH': 'Chandigarh',
  'PUNJAB': 'Punjab', 'RAJASTHAN': 'Rajasthan', 'TAMIL NADU': 'Tamil Nadu', 'UTTAR PRADESH': 'Uttar Pradesh', 'UTTARAKHAND': 'Uttarakhand',
  'WEST BENGAL': 'West Bengal', 'ANDAMAN & NICOBAR ISLANDS': 'Andaman and Nicobar Islands', 'SIKKIM': 'Sikkim'
};
// Leh and Kargil were part of Jammu & Kashmir in the directory; they are the union territory of Ladakh now
const LADAKH_DISTRICTS = new Set(['LEH', 'KARGIL', 'LEH LADAKH', 'LEH (LADAKH)']);

// places that are neighbourhoods or sights inside a bigger city, not cities themselves
const NOT_CITIES = new Set(['Haveli', 'Mulshi', 'Maval', 'Velhe', 'Assangthang', 'Chujachen', 'Dentam', 'Dikchu', 'Kaluk', 'Kewzing', 'Mamring', 'Rinchenpong', 'Sombaria', 'Tarku', 'Tashiding', 'Uttarey', 'Yangang', 'Yuksom', 'Temi', 'Hinjewadi', 'Wagholi', 'Kharadi', 'Hadapsar', 'Baner', 'Aundh', 'Kothrud', 'Katraj', 'Dhankawadi', 'Swargate', 'Shivajinagar', 'Deccan', 'Camp', 'Koregaon Park', 'Viman Nagar', 'Yerawada', 'Mundhwa', 'Kondhwa', 'Wanowrie', 'Fursungi', 'Loni Kalbhor', 'Theur', 'Ranjangaon', 'Sanaswadi', 'Kendur', 'Talegaon Dhamdhere', 'Shikrapur', 'Pimple Saudagar', 'Wakad', 'Bhosari', 'Nigdi', 'Akurdi', 'Chinchwad', 'Pirangut', 'Paud', 'Urse', 'Shirgaon', 'Kamshet', 'Uruli Kanchan', 'Yavat', 'Vadgaon Maval',
  'Kukatpally', 'Uppal', 'LB Nagar', 'Patancheru', 'Ameenpur', 'Shamshabad', 'Rajendranagar', 'Gachibowli', 'Madhapur', 'Hitec City', 'Kompally', 'Alwal', 'Malkajgiri', 'Dilsukhnagar', 'Charminar', 'Mehdipatnam', 'Banjara Hills', 'Jubilee Hills', 'Nagaram', 'Ghatkesar', 'Keesara', 'Shamirpet',
  'Lal Chowk', 'Khanyar', 'Salkia', 'Shibpur', 'Liluah', 'Belur', 'Bantra', 'Whitefield', 'Hebbal', 'Jigani', 'Attibele', 'Bidadi', 'Harohalli',
  'Edappally', 'Vyttila', 'Kakkanad', 'Palarivattom', 'Fort Kochi', 'Mattancherry', 'Thoppumpady', 'Aroor', 'Kumbalangi', 'Elamkulam', 'Kazhakkoottam', 'Neyyar Dam', 'Poovar', 'Kuttanad', 'Dona Paula', 'Merces', 'Bambolim', 'Taleigao', 'Raia', 'Loutolim', 'Sancoale', 'Varca', 'Majorda', 'Cavelossim', 'Assagao', 'Morjim', 'Baga', 'Arambol', 'Chicalim', 'Dabolim', 'Corlim', 'Tiswadi', 'Saligao', 'Aldona', 'Siolim', 'Betim', 'Candolim', 'Colva', 'Benaulim', 'Calangute', 'Anjuna',
  'Hitec City', 'Gurukul', 'Kufri', 'Khajjiar', 'Banikhet', 'Tissa', 'Nako', 'Tabo', 'Sangla', 'Kalpa', 'Sarahan', 'Pangi', 'Killar', 'Bir', 'Bhawarna', 'Chowari', 'Lachung', 'Lachen', 'Chungthang', 'Hee Gaon', 'Reiek', 'Hanle', 'Chushot', 'Thiksey', 'Stakna', 'Saspol', 'Alchi', 'Turtuk', 'Kokernag', 'Verinag', 'Lolab', 'Karnah', 'Hirakud', 'Burla', 'Belpahar', 'Konark', 'Chilika', 'Gopalpur']);

// modern spelling -> the older spelling(s) the directory still uses (only used to find the city in the directory)
const ALIASES = {
  guwahati: ['gauhati'], kadapa: ['cuddapah'], amaravati: ['amaravathi', 'amaravati'], mehsana: ['mahesana', 'mehsana'], sagara: ['sagar'], palakollu: ['palacole', 'palakol'], pala: ['palai'], bengaluru: ['bangalore'], mysuru: ['mysore'], mangaluru: ['mangalore'], belagavi: ['belgaum'], kalaburagi: ['gulbarga'], ballari: ['bellary'], vijayapura: ['bijapur'],
  shivamogga: ['shimoga'], tumakuru: ['tumkur'], hosapete: ['hospet'], hubballi: ['hubli'], chikkamagaluru: ['chikmagalur', 'chickmagalur'], gurugram: ['gurgaon'], prayagraj: ['allahabad'],
  narmadapuram: ['hoshangabad'], kochi: ['cochin', 'ernakulam'], kozhikode: ['calicut'], thiruvananthapuram: ['trivandrum'], thrissur: ['trichur'], kollam: ['quilon'],
  alappuzha: ['alleppey'], kannur: ['cannanore'], palakkad: ['palghat'], vadodara: ['baroda'], chhatrapatisambhajinagar: ['aurangabad'], dharashiv: ['osmanabad'],
  tiruchirappalli: ['trichy', 'tiruchirapalli', 'tiruchchirappalli'], thoothukudi: ['tuticorin'], puducherry: ['pondicherry'], udhagamandalam: ['ooty', 'ootacamund'],
  visakhapatnam: ['vishakhapatnam'], shrirampur: ['srirampur'], dwarka: ['dwaraka'], bhubaneswar: ['bhubaneshwar'], hazaribagh: ['hazaribag'], medininagar: ['daltonganj'],
  thiruvalla: ['tiruvalla'], payyanur: ['payyannur'], sultanbathery: ['sulthanbathery'], mananthavady: ['manathavady'], kasaragod: ['kasargod'], pathanamthitta: ['pathanamthitta'],
  jhajjar: ['jhajhar'], hansi: ['hansi'], sarkaghat: ['sarkaghat'], bijnor: ['bijnaur'], kheragarh: ['kheragarh'], shikohabad: ['shikohabad'],
  raebareli: ['rae bareli', 'raebareilly', 'rae bareilly'], lakhimpur: ['lakhimpurkheri', 'lakhimpur kheri'], mughalsarai: ['mughal sarai'], budaun: ['badaun'], kanpur: ['kanpurnagar'],
  kolkata: ['calcutta'], bardhaman: ['burdwan', 'barddhaman'], baharampur: ['berhampore', 'berhampur'], coochbehar: ['koch bihar', 'kochbihar'],
  medinipur: ['midnapore', 'midnapur'], haldia: ['haldia'], siliguri: ['siliguri'], darjeeling: ['darjiling'], jalpaiguri: ['jalpaiguri'], malda: ['maldah', 'english bazar'],
  panaji: ['panjim'], margao: ['madgaon'], vascodagama: ['vasco'], thanesar: ['kurukshetra'], hisar: ['hissar'], rewari: ['rewari'], dehradun: ['dehra dun', 'dehradun'],
  ahmednagar: ['ahmed nagar', 'ahmadnagar'], solapur: ['sholapur'], kolhapur: ['kolhapur'], jalgaon: ['jalgaon'], raigarh: ['raigarh'], vasai: ['bassein'], thane: ['thana'],
  sambhal: ['sambhal'], hapur: ['panchsheel nagar'], amroha: ['jyotiba phule nagar'], bhadohi: ['sant ravidas nagar'], kasganj: ['kanshiram nagar'], ayodhya: ['faizabad'],
  shimla: ['simla'], dharamshala: ['dharamsala'], tiruvannamalai: ['thiruvannamalai'], kanchipuram: ['kancheepuram'], nagercoil: ['kanyakumari'], tirunelveli: ['tirunelveli kattabo', 'tirunelveli'],
  thiruvarur: ['tiruvarur'], pudukkottai: ['pudukkotai'], krishnagiri: ['krishnagiri'], tiruppur: ['tirupur'], karaikudi: ['karaikudi'], coonoor: ['coonoor'], hosur: ['hosur'],
  secunderabad: ['secunderabad'], warangal: ['warangal'], karimnagar: ['karimnagar'], mahbubnagar: ['mahabubnagar'], sangareddy: ['sangareddy', 'medak'], bhongir: ['bhuvanagiri'],
  jagtial: ['jagityal'], siddipet: ['siddipet'], kothagudem: ['kothagudem'], ramagundam: ['godavarikhani'], nirmal: ['nirmal'], mancherial: ['mancherial'],
  purnia: ['purnea', 'purnia'], arrah: ['ara', 'arrah'], chhapra: ['chapra'], motihari: ['motihari'], bhagalpur: ['bhagalpur'], munger: ['monghyr'], biharsharif: ['bihar sarif', 'biharsharif'],
  aurangabad: ['aurangabad'], bhabua: ['kaimur', 'bhabhua'], ranchi: ['ranchi'], dhanbad: ['dhanbad'], bokarosteelcity: ['bokaro', 'bokaro steel city'], jamshedpur: ['jamshedpur'],
  cuttack: ['cuttack'], berhampur: ['berhampur', 'brahmapur'], balasore: ['baleshwar', 'balasore'], bhadrak: ['bhadrak'], baripada: ['baripada'], paradip: ['paradeep', 'paradip'],
  koraput: ['koraput'], phulbani: ['phulbani'], balangir: ['bolangir', 'balangir'], bhawanipatna: ['bhawanipatna'], paralakhemundi: ['parlakhemundi', 'paralakhemundi'],
  jeypore: ['jeypur', 'jeypore'], rourkela: ['rourkela'], sambalpur: ['sambalpur'], puri: ['puri'], kendrapara: ['kendrapara'], jagatsinghpur: ['jagatsinghpur'],
  keonjhar: ['keonjhar', 'kendujhar'], angul: ['anugul', 'angul'], dhenkanal: ['dhenkanal'], talcher: ['talcher'], malkangiri: ['malkangiri'], nabarangpur: ['nabarangpur'],
  nuapada: ['nuapada'], boudh: ['baudh', 'boudh'], sonepur: ['sonepur', 'subarnapur'], sundargarh: ['sundargarh'], jajpur: ['jajpur'], khordha: ['khurda', 'khordha'], nayagarh: ['nayagarh'],
  gajapati: ['gajapati'], jharsuguda: ['jharsuguda'], barbil: ['barbil'], rayagada: ['rayagada'], bargarh: ['bargarh']
};
// Well-known cities that India Post's older directory spells differently or files under a neighbourhood name, so the automatic
// check cannot see them. Each one is a real city or town of the state it is listed under.
const KEEP = {
  'Maharashtra': ['Vasai-Virar', 'Navi Mumbai', 'Mira-Bhayandar', 'Pimpri-Chinchwad', 'Achalpur'],
  'Assam': ['Guwahati', 'Biswanath Chariali'],
  'Uttar Pradesh': ['Greater Noida', 'Pilkhuwa'],
  'Uttarakhand': ['Srinagar', 'Haldwani', 'Kedarnath', 'Badrinath', 'New Tehri'],
  'Rajasthan': ['Mount Abu', 'Bhiwadi', 'Kuchaman City', 'Sambhar'],
  'Tamil Nadu': ['Mahabalipuram', 'Ooty', 'Sirkazhi', 'Jolarpet', 'Padmanabhapuram', 'Cumbum'],
  'Sikkim': ['Gyalshing'],
  'Kerala': ['Cherpulassery', 'Wadakkanchery', 'Kilimanoor', 'North Paravur', 'Thamarassery', 'Koduvally'],
  'Punjab': ['Jaito', 'Goniana', 'Sahnewal', 'Goindwal Sahib'],
  'Haryana': ['Ratia', 'Meham', 'Adampur', 'Ambala Cantonment'],
  'Telangana': ['Gajwel', 'Parigi'],
  'Karnataka': ['Rabkavi Banhatti'],
  'Goa': ['Old Goa'],
  'Jammu and Kashmir': ['Surankote'],
  'Andhra Pradesh': ['Sri City'],
  'Ladakh': ['Khaltse'],
  'Himachal Pradesh': ['Dehri'],
  'Jharkhand': ['Phusro'],
  'Chhattisgarh': ['Naila Janjgir'],
  'Odisha': ['Panposh'],
  'West Bengal': ['Rajarhat'],
  'Dadra and Nagar Haveli and Daman and Diu': ['Nani Daman']
};
const key = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]/g, '');
// small spelling differences ("Himmatnagar"/"Himatnagar", "Mehsana"/"Mahesana") still count as the same place
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const nearKnown = (set, k) => { if (k.length < 6) return false; const max = k.length >= 10 ? 2 : 1; for (const n of set) { if (Math.abs(n.length - k.length) <= max && editDistance(k, n, max) <= max) return true; } return false; };

const dirPath = process.argv[2];
if (!dirPath) { console.error('Usage: node tools/build-india-geo.js path/to/all-india-pincode-json-array.json'); process.exit(1); }
const dir = JSON.parse(fs.readFileSync(dirPath, 'utf8'));

function stateOfRow(r) {
  const n = DIR_STATE[String(r.statename || '').toUpperCase()];
  if (!n) return null;
  if (n === 'Jammu and Kashmir' && LADAKH_DISTRICTS.has(String(r.Districtname || '').toUpperCase())) return 'Ladakh';
  return n;
}

// names the directory carries, per state: districts, taluks and post offices
const known = {}; STATES.forEach(s => { known[s] = new Set(); });
const pinStates = {};   // pincode -> Set of states
const prefix3 = {};     // 3-digit prefix -> Set of states
for (const r of dir) {
  const st = stateOfRow(r); if (!st) continue;
  const pin = String(r.pincode);
  if (/^[1-9]\d{5}$/.test(pin)) { (pinStates[pin] || (pinStates[pin] = new Set())).add(st); (prefix3[pin.slice(0, 3)] || (prefix3[pin.slice(0, 3)] = new Set())).add(st); }
  [r.Districtname, r.Taluk, String(r.officename || '').replace(/\s+(B\.O|S\.O|H\.O).*$/i, '')].forEach(n => { if (n && n !== 'NA' && n !== 'NULL') known[st].add(key(n)); });
}
// union territory / state special cases: Delhi's known places include New Delhi; Chandigarh is one city
known['Delhi'].add('delhi'); known['Delhi'].add('newdelhi'); known['Chandigarh'].add('chandigarh');

const cities = {}; const report = [];
for (const st of STATES) {
  const seen = new Set(); const out = [];
  for (const raw of (source[st] || '').split('|')) {
    const name = raw.trim(); if (!name || NOT_CITIES.has(name)) continue;
    const k = key(name); if (!k || seen.has(k)) continue;
    const forms = [k, ...((ALIASES[k] || []).map(key))];
    // 'Bhilai Nagar' / 'Kalyan City' style: also try the name without a trailing word
    const loose = k.replace(/(nagar|city|town)$/, '');
    const ok = forms.some(f => known[st].has(f)) || (loose.length > 4 && known[st].has(loose)) || forms.some(f => nearKnown(known[st], f));
    if (!ok && !(KEEP[st] || []).includes(name)) { report.push(st + ': ' + name); continue; }
    seen.add(k); out.push(name);
  }
  cities[st] = out.sort((a, b) => a.localeCompare(b, 'en'));
}

// every state must still list its capital / best-known city (a safety net against a bad edit or a data change)
const MUST_HAVE = { 'Andaman and Nicobar Islands': 'Port Blair', 'Andhra Pradesh': 'Visakhapatnam', 'Arunachal Pradesh': 'Itanagar', 'Assam': 'Dispur', 'Bihar': 'Patna', 'Chandigarh': 'Chandigarh', 'Chhattisgarh': 'Raipur',
  'Dadra and Nagar Haveli and Daman and Diu': 'Silvassa', 'Delhi': 'New Delhi', 'Goa': 'Panaji', 'Gujarat': 'Ahmedabad', 'Haryana': 'Gurugram', 'Himachal Pradesh': 'Shimla', 'Jammu and Kashmir': 'Srinagar', 'Jharkhand': 'Ranchi',
  'Karnataka': 'Bengaluru', 'Kerala': 'Thiruvananthapuram', 'Ladakh': 'Leh', 'Lakshadweep': 'Kavaratti', 'Madhya Pradesh': 'Bhopal', 'Maharashtra': 'Mumbai', 'Manipur': 'Imphal', 'Meghalaya': 'Shillong', 'Mizoram': 'Aizawl',
  'Nagaland': 'Kohima', 'Odisha': 'Bhubaneswar', 'Puducherry': 'Puducherry', 'Punjab': 'Ludhiana', 'Rajasthan': 'Jaipur', 'Sikkim': 'Gangtok', 'Tamil Nadu': 'Chennai', 'Telangana': 'Hyderabad', 'Tripura': 'Agartala',
  'Uttar Pradesh': 'Lucknow', 'Uttarakhand': 'Dehradun', 'West Bengal': 'Kolkata' };
for (const [st, c] of Object.entries(MUST_HAVE)) if (!cities[st].includes(c)) { console.error('MISSING: ' + c + ' under ' + st); process.exitCode = 1; }

const stateIdx = Object.fromEntries(STATES.map((s, i) => [s, i]));
const pins = {}; Object.keys(pinStates).sort().forEach(p => { const arr = [...pinStates[p]].map(s => stateIdx[s]); pins[p] = arr.length === 1 ? arr[0] : arr; });
const p3 = {}; Object.keys(prefix3).sort().forEach(p => { const arr = [...prefix3[p]].map(s => stateIdx[s]).sort((a, b) => a - b); p3[p] = arr.length === 1 ? arr[0] : arr; });

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'india-geo.json'), JSON.stringify({ states: STATES, cities, p3 }));
fs.writeFileSync(path.join(dataDir, 'india-pins.json'), JSON.stringify(pins));
const browser = `// Generated by backend/tools/build-india-geo.js - do not edit by hand. Indian states, their cities, and the pincode prefixes that belong to each state.\nwindow.INDIA_GEO=${JSON.stringify({ states: STATES, cities, p3 })};\n`;
fs.writeFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'india-geo.js'), browser);

const total = Object.values(cities).reduce((n, l) => n + l.length, 0);
console.log('states', STATES.length, 'cities', total, 'pincodes', Object.keys(pins).length, '3-digit prefixes', Object.keys(p3).length);
STATES.forEach(s => console.log('  ' + s.padEnd(44) + String(cities[s].length).padStart(4)));
console.log('\nNot found in India Post records for that state (left out): ' + report.length);
console.log(report.join('\n'));

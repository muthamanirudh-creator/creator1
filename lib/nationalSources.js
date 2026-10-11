// v2.10.0 - National coverage: official recruiters for every State and Union Territory plus more central bodies.
// ALLOWLIST ONLY. Every row is seeded PENDING_VERIFICATION and is trusted only by evidence at run time
// (lib/sourcePolicy.autoVerifyPending: https, official domain, public address, page answers, page talks about recruitment).
//
// confirmed:true  = the domain was checked against live public pages when this file was written (2026-10-11).
// confirmed:false = from public knowledge of the body's usual site; it is NOT assumed correct. If the portal does not answer
//                   or does not look like a recruiter, autoVerify leaves it pending and lib/domainGuard flags it for review.
// tier: 1 = checked every 5 min (commissions / boards whose notices matter most), 2 = every 10 min, 3 = every 20 min.
const TIER_MINUTES = { 1: 5, 2: 10, 3: 20 };

const S = (source_id, organization, department, official_domain, portal_url, state, tier = 2, confirmed = false) =>
  ({ source_id, organization, department, official_domain, portal_url, state, tier, confirmed });

const STATES_AND_UTS = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

// Sources that already exist in lib/registry.js (upsc, ssc, ibps, sbi-careers, appsc, tgpsc) and lib/sourcePolicy.js (ncs, rrb-apply,
// indian-railways, rbi, drdo, isro, join-indian-army, epfo, ongc, ntpc, powergrid, iocl, kvs, mha) are NOT repeated here.
const NATIONAL_SOURCES = [
  // ---- Punjab (corrected). PPSC and the Subordinate Services Selection Board were checked on live public pages. ----
  S('ppsc', 'Punjab Public Service Commission', 'State recruitment', 'ppsc.gov.in', 'https://ppsc.gov.in/', 'Punjab', 1, true),
  S('psssb', 'Subordinate Services Selection Board, Punjab (PSSSB)', 'State recruitment', 'sssb.punjab.gov.in', 'https://sssb.punjab.gov.in/', 'Punjab', 1, true),
  S('punjab-police', 'Punjab Police', 'Police recruitment', 'punjabpolice.gov.in', 'https://punjabpolice.gov.in/', 'Punjab', 2),
  S('pspcl', 'Punjab State Power Corporation Limited', 'Power utility (PSU)', 'pspcl.in', 'https://pspcl.in/', 'Punjab', 2),
  S('punjab-govt', 'Government of Punjab (state portal)', 'State government', 'punjab.gov.in', 'https://punjab.gov.in/', 'Punjab', 3),

  // ---- States: commissions and the main staff / police boards ----
  S('slprb-ap', 'AP State Level Police Recruitment Board', 'Police recruitment', 'slprb.ap.gov.in', 'https://slprb.ap.gov.in/', 'Andhra Pradesh', 2),
  S('appsc-ar', 'Arunachal Pradesh Public Service Commission', 'State recruitment', 'appsc.gov.in', 'https://appsc.gov.in/', 'Arunachal Pradesh', 2),
  S('apsc', 'Assam Public Service Commission', 'State recruitment', 'apsc.nic.in', 'https://apsc.nic.in/', 'Assam', 2),
  S('bpsc', 'Bihar Public Service Commission', 'State recruitment', 'bpsc.bihar.gov.in', 'https://bpsc.bihar.gov.in/', 'Bihar', 1, true),
  S('bssc', 'Bihar Staff Selection Commission', 'State recruitment', 'bssc.bihar.gov.in', 'https://bssc.bihar.gov.in/', 'Bihar', 1),
  S('csbc-bihar', 'Central Selection Board of Constable, Bihar', 'Police recruitment', 'csbc.bihar.gov.in', 'https://csbc.bihar.gov.in/', 'Bihar', 2),
  S('cgpsc', 'Chhattisgarh Public Service Commission', 'State recruitment', 'psc.cg.gov.in', 'https://psc.cg.gov.in/', 'Chhattisgarh', 2),
  S('gpsc-goa', 'Goa Public Service Commission', 'State recruitment', 'gpsc.goa.gov.in', 'https://gpsc.goa.gov.in/', 'Goa', 2),
  S('gpsc', 'Gujarat Public Service Commission', 'State recruitment', 'gpsc.gujarat.gov.in', 'https://gpsc.gujarat.gov.in/', 'Gujarat', 1),
  S('gsssb', 'Gujarat Subordinate Services Selection Board', 'State recruitment', 'gsssb.gujarat.gov.in', 'https://gsssb.gujarat.gov.in/', 'Gujarat', 1),
  S('hpsc', 'Haryana Public Service Commission', 'State recruitment', 'hpsc.gov.in', 'https://hpsc.gov.in/', 'Haryana', 1),
  S('hssc', 'Haryana Staff Selection Commission', 'State recruitment', 'hssc.gov.in', 'https://hssc.gov.in/', 'Haryana', 1),
  S('hppsc', 'Himachal Pradesh Public Service Commission', 'State recruitment', 'hppsc.hp.gov.in', 'https://hppsc.hp.gov.in/', 'Himachal Pradesh', 2),
  S('jpsc', 'Jharkhand Public Service Commission', 'State recruitment', 'jpsc.gov.in', 'https://jpsc.gov.in/', 'Jharkhand', 2),
  S('jssc', 'Jharkhand Staff Selection Commission', 'State recruitment', 'jssc.nic.in', 'https://jssc.nic.in/', 'Jharkhand', 2),
  S('kpsc', 'Karnataka Public Service Commission', 'State recruitment', 'kpsc.kar.nic.in', 'https://kpsc.kar.nic.in/', 'Karnataka', 1),
  S('kea', 'Karnataka Examinations Authority', 'State recruitment', 'kea.kar.nic.in', 'https://kea.kar.nic.in/', 'Karnataka', 2),
  S('keralapsc', 'Kerala Public Service Commission', 'State recruitment', 'keralapsc.gov.in', 'https://www.keralapsc.gov.in/', 'Kerala', 1),
  S('mppsc', 'Madhya Pradesh Public Service Commission', 'State recruitment', 'mppsc.mp.gov.in', 'https://mppsc.mp.gov.in/', 'Madhya Pradesh', 1),
  S('mpesb', 'Madhya Pradesh Employees Selection Board', 'State recruitment', 'esb.mp.gov.in', 'https://esb.mp.gov.in/', 'Madhya Pradesh', 1),
  S('mpsc', 'Maharashtra Public Service Commission', 'State recruitment', 'mpsc.gov.in', 'https://mpsc.gov.in/', 'Maharashtra', 1),
  S('mpsc-manipur', 'Manipur Public Service Commission', 'State recruitment', 'mpscmanipur.gov.in', 'https://mpscmanipur.gov.in/', 'Manipur', 3),
  S('mpsc-meghalaya', 'Meghalaya Public Service Commission', 'State recruitment', 'mpsc.nic.in', 'https://mpsc.nic.in/', 'Meghalaya', 3),
  S('mpsc-mizoram', 'Mizoram Public Service Commission', 'State recruitment', 'mpsc.mizoram.gov.in', 'https://mpsc.mizoram.gov.in/', 'Mizoram', 3),
  S('npsc', 'Nagaland Public Service Commission', 'State recruitment', 'npsc.nagaland.gov.in', 'https://npsc.nagaland.gov.in/', 'Nagaland', 3),
  S('opsc', 'Odisha Public Service Commission', 'State recruitment', 'opsc.gov.in', 'https://opsc.gov.in/', 'Odisha', 1),
  S('ossc', 'Odisha Staff Selection Commission', 'State recruitment', 'ossc.gov.in', 'https://ossc.gov.in/', 'Odisha', 2),
  S('rpsc', 'Rajasthan Public Service Commission', 'State recruitment', 'rpsc.rajasthan.gov.in', 'https://rpsc.rajasthan.gov.in/', 'Rajasthan', 1),
  S('rsmssb', 'Rajasthan Staff Selection Board', 'State recruitment', 'rsmssb.rajasthan.gov.in', 'https://rsmssb.rajasthan.gov.in/', 'Rajasthan', 1),
  S('spsc-sikkim', 'Sikkim Public Service Commission', 'State recruitment', 'spsc.sikkim.gov.in', 'https://spsc.sikkim.gov.in/', 'Sikkim', 3),
  S('tnpsc', 'Tamil Nadu Public Service Commission', 'State recruitment', 'tnpsc.gov.in', 'https://www.tnpsc.gov.in/', 'Tamil Nadu', 1),
  S('tnusrb', 'Tamil Nadu Uniformed Services Recruitment Board', 'Police recruitment', 'tnusrb.tn.gov.in', 'https://tnusrb.tn.gov.in/', 'Tamil Nadu', 2),
  S('tpsc', 'Tripura Public Service Commission', 'State recruitment', 'tpsc.tripura.gov.in', 'https://tpsc.tripura.gov.in/', 'Tripura', 3),
  S('uppsc', 'Uttar Pradesh Public Service Commission', 'State recruitment', 'uppsc.up.nic.in', 'https://uppsc.up.nic.in/', 'Uttar Pradesh', 1),
  S('upsssc', 'Uttar Pradesh Subordinate Service Selection Commission', 'State recruitment', 'upsssc.gov.in', 'https://upsssc.gov.in/', 'Uttar Pradesh', 1),
  S('uppbpb', 'Uttar Pradesh Police Recruitment and Promotion Board', 'Police recruitment', 'uppbpb.gov.in', 'https://uppbpb.gov.in/', 'Uttar Pradesh', 1),
  S('ukpsc', 'Uttarakhand Public Service Commission', 'State recruitment', 'psc.uk.gov.in', 'https://psc.uk.gov.in/', 'Uttarakhand', 2),
  S('uksssc', 'Uttarakhand Subordinate Service Selection Commission', 'State recruitment', 'sssc.uk.gov.in', 'https://sssc.uk.gov.in/', 'Uttarakhand', 2),
  S('wbpsc', 'West Bengal Public Service Commission', 'State recruitment', 'psc.wb.gov.in', 'https://psc.wb.gov.in/', 'West Bengal', 1),
  S('wbssc', 'West Bengal School Service Commission', 'State recruitment', 'wbssc.gov.in', 'https://wbssc.gov.in/', 'West Bengal', 2),

  // ---- Union Territories ----
  S('dsssb', 'Delhi Subordinate Services Selection Board', 'State recruitment', 'dsssb.delhi.gov.in', 'https://dsssb.delhi.gov.in/', 'Delhi', 1),
  S('jkpsc', 'Jammu & Kashmir Public Service Commission', 'State recruitment', 'jkpsc.nic.in', 'https://jkpsc.nic.in/', 'Jammu and Kashmir', 1),
  S('jkssb', 'Jammu & Kashmir Services Selection Board', 'State recruitment', 'jkssb.nic.in', 'https://jkssb.nic.in/', 'Jammu and Kashmir', 1),
  S('chandigarh-admin', 'Chandigarh Administration', 'UT administration', 'chandigarh.gov.in', 'https://chandigarh.gov.in/', 'Chandigarh', 3),
  S('ladakh-admin', 'UT Ladakh Administration', 'UT administration', 'ladakh.gov.in', 'https://ladakh.gov.in/', 'Ladakh', 3),
  S('puducherry-govt', 'Government of Puducherry', 'UT administration', 'py.gov.in', 'https://www.py.gov.in/', 'Puducherry', 3),
  S('andaman-admin', 'Andaman & Nicobar Administration', 'UT administration', 'andaman.gov.in', 'https://www.andaman.gov.in/', 'Andaman and Nicobar Islands', 3),
  S('lakshadweep-admin', 'Lakshadweep Administration', 'UT administration', 'lakshadweep.gov.in', 'https://lakshadweep.gov.in/', 'Lakshadweep', 3),
  S('dnhdd-admin', 'Dadra & Nagar Haveli and Daman & Diu Administration', 'UT administration', 'dnhdd.gov.in', 'https://dnhdd.gov.in/', 'Dadra and Nagar Haveli and Daman and Diu', 3),

  // ---- More central recruiters (All India) ----
  S('cisf', 'Central Industrial Security Force', 'Paramilitary', 'cisf.gov.in', 'https://www.cisf.gov.in/', 'All India', 2),
  S('crpf', 'Central Reserve Police Force', 'Paramilitary', 'crpf.gov.in', 'https://crpf.gov.in/', 'All India', 2),
  S('bsf', 'Border Security Force', 'Paramilitary', 'bsf.gov.in', 'https://bsf.gov.in/', 'All India', 2),
  S('itbp', 'Indo-Tibetan Border Police', 'Paramilitary', 'itbpolice.nic.in', 'https://itbpolice.nic.in/', 'All India', 2),
  S('assam-rifles', 'Assam Rifles', 'Paramilitary', 'assamrifles.gov.in', 'https://assamrifles.gov.in/', 'All India', 3),
  S('indian-navy', 'Indian Navy', 'Defence', 'joinindiannavy.gov.in', 'https://www.joinindiannavy.gov.in/', 'All India', 2),
  S('coast-guard', 'Indian Coast Guard', 'Defence', 'joinindiancoastguard.gov.in', 'https://joinindiancoastguard.gov.in/', 'All India', 3),
  S('india-post', 'India Post', 'Posts', 'indiapost.gov.in', 'https://www.indiapost.gov.in/', 'All India', 2),
  S('india-post-gds', 'India Post Gramin Dak Sevak', 'Posts', 'indiapostgdsonline.gov.in', 'https://indiapostgdsonline.gov.in/', 'All India', 1),
  S('esic', 'Employees\' State Insurance Corporation', 'Labour', 'esic.gov.in', 'https://www.esic.gov.in/', 'All India', 2),
  S('nielit', 'NIELIT', 'Electronics & IT', 'nielit.gov.in', 'https://www.nielit.gov.in/', 'All India', 3),
  S('barc', 'Bhabha Atomic Research Centre', 'Atomic energy', 'barc.gov.in', 'https://www.barc.gov.in/', 'All India', 3),
  S('icmr', 'Indian Council of Medical Research', 'Health research', 'icmr.gov.in', 'https://www.icmr.gov.in/', 'All India', 3),
  S('cbic', 'Central Board of Indirect Taxes & Customs', 'Revenue', 'cbic.gov.in', 'https://www.cbic.gov.in/', 'All India', 3),
  S('cbse', 'Central Board of Secondary Education', 'Education', 'cbse.gov.in', 'https://www.cbse.gov.in/', 'All India', 3),
  S('nvs', 'Navodaya Vidyalaya Samiti', 'Education', 'navodaya.gov.in', 'https://navodaya.gov.in/', 'All India', 2),
  S('licindia', 'Life Insurance Corporation of India', 'Insurance (PSU)', 'licindia.in', 'https://licindia.in/', 'All India', 2),
  S('nabard', 'NABARD', 'Development bank', 'nabard.org', 'https://www.nabard.org/', 'All India', 2),
  S('pnb', 'Punjab National Bank', 'Public sector bank', 'pnbindia.in', 'https://www.pnbindia.in/', 'All India', 2),
  S('bob', 'Bank of Baroda', 'Public sector bank', 'bankofbaroda.in', 'https://www.bankofbaroda.in/', 'All India', 2),
  S('canara-bank', 'Canara Bank', 'Public sector bank', 'canarabank.com', 'https://canarabank.com/', 'All India', 2),
  S('union-bank', 'Union Bank of India', 'Public sector bank', 'unionbankofindia.co.in', 'https://www.unionbankofindia.co.in/', 'All India', 2),
  S('bank-of-india', 'Bank of India', 'Public sector bank', 'bankofindia.co.in', 'https://bankofindia.co.in/', 'All India', 2),
];

// Non-.gov.in / non-.nic.in domains of the PSU recruiters above. Added to the official allowlist in lib/sourcePolicy.js.
const EXTRA_OFFICIAL_EXACT = ['pspcl.in', 'pstcl.org', 'pnbindia.in', 'bankofbaroda.in', 'canarabank.com', 'unionbankofindia.co.in', 'bankofindia.co.in'];

// Domains that are known to be wrong or stale for a source id. The right-hand side is the one to use.
// A row that still carries a stale value is corrected by reconcile() and sent back to PENDING_VERIFICATION.
const DOMAIN_FIXES = {
  ppsc: { stale: ['ppsc.nic.in', 'pspsc.gov.in', 'ppsc.punjab.gov.in', 'punjabpsc.gov.in', 'ppsc.gop.pk', 'www.ppsc.gop.pk', 'ppsc.gov.pk'], fix: { official_domain: 'ppsc.gov.in', portal_url: 'https://ppsc.gov.in/' } },
  psssb: { stale: ['psssb.gov.in', 'sssb.punjab.nic.in', 'psssb.punjab.gov.in', 'subordinateservices.punjab.gov.in'], fix: { official_domain: 'sssb.punjab.gov.in', portal_url: 'https://sssb.punjab.gov.in/' } },
  bpsc: { stale: ['bpsc.bih.nic.in'], fix: { official_domain: 'bpsc.bihar.gov.in', portal_url: 'https://bpsc.bihar.gov.in/' } },
};

// Domains of other countries that look like Indian bodies (Pakistan's Punjab PSC is ppsc.gop.pk). Never accepted.
const FOREIGN_LOOKALIKE_SUFFIXES = ['.pk', '.gop.pk', '.gov.pk', '.com.pk', '.bd', '.gov.bd', '.lk', '.gov.lk', '.np', '.gov.np'];

// Host tags used inside state sub-domains: <body>.<tag>.gov.in / <body>.<tag>.nic.in. Used to catch a source filed under the wrong state.
const STATE_TAGS = {
  'Andhra Pradesh': ['ap'], 'Arunachal Pradesh': ['arunachal'], Assam: ['assam'], Bihar: ['bihar', 'bih'], Chhattisgarh: ['cg', 'cgstate'], Goa: ['goa'],
  Gujarat: ['gujarat'], Haryana: ['haryana'], 'Himachal Pradesh': ['hp'], Jharkhand: ['jharkhand'], Karnataka: ['kar', 'karnataka'], Kerala: ['kerala'],
  'Madhya Pradesh': ['mp'], Maharashtra: ['maharashtra'], Manipur: ['manipur'], Meghalaya: ['meghalaya'], Mizoram: ['mizoram'], Nagaland: ['nagaland'],
  Odisha: ['odisha'], Punjab: ['punjab'], Rajasthan: ['rajasthan'], Sikkim: ['sikkim'], 'Tamil Nadu': ['tn'], Telangana: ['telangana', 'ts'], Tripura: ['tripura'],
  'Uttar Pradesh': ['up'], Uttarakhand: ['uk', 'uttarakhand'], 'West Bengal': ['wb'], Delhi: ['delhi'], 'Jammu and Kashmir': ['jk', 'jammu'], Ladakh: ['ladakh'],
  Puducherry: ['py', 'puducherry'], Chandigarh: ['chandigarh'],
};

const tierMinutes = (tier, env = process.env) => {
  const o = Number(env[`CRAWL_MINUTES_T${tier}`]);
  return Number.isFinite(o) && o >= 1 ? Math.floor(o) : (TIER_MINUTES[tier] || TIER_MINUTES[3]);
};

module.exports = { TIER_MINUTES, STATES_AND_UTS, NATIONAL_SOURCES, EXTRA_OFFICIAL_EXACT, DOMAIN_FIXES, FOREIGN_LOOKALIKE_SUFFIXES, STATE_TAGS, tierMinutes };

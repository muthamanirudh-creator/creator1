const LANGS = {
  en:{name:'English',native:'English'}, hi:{name:'Hindi',native:'हिन्दी'}, bn:{name:'Bengali',native:'বাংলা'}, te:{name:'Telugu',native:'తెలుగు'}, mr:{name:'Marathi',native:'मराठी'}, ta:{name:'Tamil',native:'தமிழ்'}, gu:{name:'Gujarati',native:'ગુજરાતી'}, kn:{name:'Kannada',native:'ಕನ್ನಡ'}, ml:{name:'Malayalam',native:'മലയാളം'}, pa:{name:'Punjabi',native:'ਪੰਜਾਬੀ'}, or:{name:'Odia',native:'ଓଡ଼ିଆ'}
};
const labels = {
  en:{apply:'Apply',eligibility:'Eligibility',deadline:'Application deadline',age:'Age limit',vacancies:'Vacancies'},
  hi:{apply:'आवेदन करें',eligibility:'पात्रता',deadline:'आवेदन की अंतिम तिथि',age:'आयु सीमा',vacancies:'रिक्तियां'},
  bn:{apply:'আবেদন করুন',eligibility:'যোগ্যতা',deadline:'আবেদনের শেষ তারিখ',age:'বয়সসীমা',vacancies:'শূন্যপদ'},
  te:{apply:'దరఖాస్తు చేయండి',eligibility:'అర్హత',deadline:'దరఖాస్తు చివరి తేదీ',age:'వయోపరిమితి',vacancies:'ఖాళీలు'},
  mr:{apply:'अर्ज करा',eligibility:'पात्रता',deadline:'अर्जाची अंतिम तारीख',age:'वयोमर्यादा',vacancies:'रिक्त पदे'},
  ta:{apply:'விண்ணப்பிக்கவும்',eligibility:'தகுதி',deadline:'விண்ணப்ப இறுதி தேதி',age:'வயது வரம்பு',vacancies:'காலியிடங்கள்'},
  gu:{apply:'અરજી કરો',eligibility:'લાયકાત',deadline:'અરજીની છેલ્લી તારીખ',age:'વય મર્યાદા',vacancies:'જગ્યાઓ'},
  kn:{apply:'ಅರ್ಜಿ ಸಲ್ಲಿಸಿ',eligibility:'ಅರ್ಹತೆ',deadline:'ಅರ್ಜಿಯ ಕೊನೆಯ ದಿನಾಂಕ',age:'ವಯೋಮಿತಿ',vacancies:'ಖಾಲಿ ಹುದ್ದೆಗಳು'},
  ml:{apply:'അപേക്ഷിക്കുക',eligibility:'യോഗ്യത',deadline:'അപേക്ഷയുടെ അവസാന തീയതി',age:'പ്രായപരിധി',vacancies:'ഒഴിവുകൾ'},
  pa:{apply:'ਅਰਜ਼ੀ ਦਿਓ',eligibility:'ਯੋਗਤਾ',deadline:'ਅਰਜ਼ੀ ਦੀ ਆਖਰੀ ਮਿਤੀ',age:'ਉਮਰ ਸੀਮਾ',vacancies:'ਅਸਾਮੀਆਂ'},
  or:{apply:'ଆବେଦନ କରନ୍ତୁ',eligibility:'ଯୋଗ୍ୟତା',deadline:'ଆବେଦନର ଶେଷ ତାରିଖ',age:'ବୟସ ସୀମା',vacancies:'ଖାଲି ପଦ'}
};
function language(code){ return LANGS[code] ? code : 'en'; }
function renderJobData(job, code='en'){ const l=language(code); const x=labels[l]; return {language:l,labels:x,dates:job.dates||{},age:job.age||{},vacancies:job.vacancies ?? job.data?.vacancies ?? null}; }
module.exports={LANGS,labels,language,renderJobData};

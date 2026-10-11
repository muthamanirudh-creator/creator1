const SUPPORTED=['hi-IN','bn-IN','te-IN','mr-IN','ta-IN','gu-IN','kn-IN','ml-IN','pa-IN','or-IN','en-IN'];
function config(){return {provider:process.env.VOICE_PROVIDER||'browser',supported_locales:SUPPORTED,privacy:'audio is processed only when the user explicitly enables voice; server does not retain browser audio by default'};}
module.exports={config};

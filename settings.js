(() => {
  'use strict';
  const theme=document.getElementById('settingsTheme'),language=document.getElementById('settingsLanguage'),status=document.getElementById('settingsStatus');
  const refresh=()=>{const preference=window.AgendaI18n?.preferences?.()||{theme:'light',language:'es'};theme.value=preference.theme;language.value=preference.language;};
  theme.addEventListener('change',()=>window.AgendaI18n?.setTheme(theme.value));
  language.addEventListener('change',()=>window.AgendaI18n?.setLanguage(language.value));
  window.addEventListener('agenda-theme-changed',()=>{refresh();status.textContent=window.AgendaI18n.t('Preferencias guardadas en este dispositivo.');});
  window.addEventListener('agenda-language-changed',()=>{refresh();status.textContent=window.AgendaI18n.t('Preferencias guardadas en este dispositivo.');});
  refresh();
})();

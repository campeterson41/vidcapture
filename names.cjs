'use strict';
// One set of human names for displays and devices, shared by the main
// window, the record panel and the picker.

// LG ULTRAWIDE -> LG Ultrawide; keeps LG, HP and model numbers like U2723QE.
const tidy=v=>String(v||'').replace(/\b([A-Z])([A-Z]{3,})\b/g,(_,a,b)=>a+b.toLowerCase()).replace(/\s+/g,' ').trim();

// Hyprland monitor JSON -> "Laptop display", "LG Ultrawide", or the connector.
function displayName(m){
  if(/^(eDP|LVDS)/.test(m.name||''))return 'Laptop display';
  const model=tidy(m.model);
  if(model&&!/^0x/i.test(model))return model;
  return m.name||'Display';
}

// Integrated_Webcam_HD: Integrate -> Integrated Webcam HD
const deviceLabel=name=>String(name||'').split(':')[0].replace(/_+/g,' ').replace(/\s+/g,' ').trim()||String(name||'');

module.exports={tidy,displayName,deviceLabel};

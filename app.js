/* NEXUS v1.02.1 — interfaz corregida y creación compatible con reglas heredadas; motor conservado.
   Firebase Spark + GitHub Pages. La lógica del navegador NO es antifraude total. */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const config = window.FIREBASE_CONFIG;
  const screens = ["pantalla-inicio","pantalla-crear","pantalla-unirse","pantalla-lobby","pantalla-juego"];
  let auth, db, user = null, currentCode = null, roomRef = null, roomCallback = null, statsRef = null, statsCallback = null;
  let room = null, selectedCard = null, busy = false, playCardBusy = false, endTurnBusy = false;
  let catalogDetailReturn = false;
  const Core = window.NexusCore;
  const ROOM_TTL_MS=Core.ROOM_TTL_MS, REMATCH_MS=Core.REMATCH_MS;
  const ROOM_LIMIT=3, CREATE_COOLDOWN_MS=20000;
  let serverOffset=0, closingRoom=false;
  const indexedFinals = new Set();
  const serverNow=()=>Date.now()+serverOffset;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  // Compatibilidad controlada: subir archivos a GitHub NO instala las reglas de Firebase.
  // Las reglas de v1.01 permiten crear salas pero niegan acceso a los índices nuevos.
  // Si no existen esos permisos, usar límites locales y una consulta de salas propias;
  // nunca confundir este modo con las protecciones completas de v1.02.
  let legacyRulesMode=false, lastLegacyCreate=0;
  const permissionDenied=e=>String(e?.code||'').toLowerCase().includes('permission_denied');
  function creationError(message='') {
    const el=$('crear-error');
    if(!el)return;
    el.textContent=message;el.classList.toggle('hidden',!message);
  }
  function fallbackCreationCooldown() {
    const now=serverNow();
    let stored=lastLegacyCreate;
    try{stored=Math.max(stored,Number(localStorage.getItem('nexus.ultimaCreacionLocal')||0));}catch(_){}
    if(now-stored<CREATE_COOLDOWN_MS)throw new Error('Espera 20 segundos antes de crear otra sala.');
    lastLegacyCreate=now;
    try{localStorage.setItem('nexus.ultimaCreacionLocal',String(now));}catch(_){}
  }

  function showScreen(id) {
    const changed=!!$(id)?.classList.contains("hidden");
    screens.forEach(s => { const el=$(s); if(el) el.classList.toggle("hidden",s!==id); });
    if(changed)window.scrollTo({top:0,behavior:"smooth"});
  }
  function say(text="") { const el=$("mensaje-global"); if(el) el.textContent=text; }
  function setStatus(text, cls="") { const el=$("estado-conexion"); if(el){el.textContent=text;el.className="connection "+cls;} }
  function fail(op, err) {
    console.error(`[${op}]`, err?.code || "", err?.message || err, err);
    const code=String(err?.code||'').toLowerCase();
    if(code.includes('permission_denied'))say(`${op}: Firebase ha rechazado la operación por permisos. Comprueba las reglas de seguridad publicadas.`);
    else if(code.includes('network')||code.includes('disconnected'))say(`${op}: No hay conexión. Comprueba Internet y vuelve a intentarlo.`);
    else if(code.startsWith('auth/'))say(`${op}: Error de autenticación. Reabre la aplicación.`);
    else say(`${op}: ${String(err?.message||err||'Operación no disponible').slice(0,240)}`);
  }
  // Contadores globales ocultos. El incremento es sencillo y se ejecuta en el servidor.
  // Spark no garantiza que un cliente malicioso no pueda falsificarlos.
  async function incrementStat(field) {
    if(!user || !db)throw new Error('Es necesaria una sesión válida para registrar estadísticas.');
    await db.ref(`estadisticasGlobales/${field}`).set(firebase.database.ServerValue.increment(1));
  }
  async function registerCreatedRoomOnce(code) {
    // El código es nuevo porque se ha reservado con una transacción atómica.
    try {await incrementStat('salasCreadas');}
    catch(e){console.warn('No se pudo contabilizar la nueva sala',code,e);}
  }
  async function registerFinishedRoomOnce(code, data) {
    if(!user||!data?.jugadores?.[user.uid]||data.juego?.estado!=='finalizada')return;
    const key=`${code}_${Number(data.numeroPartida||1)}`;
    const marker=db.ref(`eventosContabilizados/${code}/${Number(data.numeroPartida||1)}`);
    // Solo una pestaña del anfitrión puede reclamar cada evento. El contador sigue
    // siendo un incremento simple; una caída entre ambas escrituras puede perderlo.
    const claim=await marker.transaction(value=>value===null?1:undefined,undefined,false);
    if(claim.committed) {
      try {await incrementStat('partidasFinalizadas');}
      catch(e){console.warn('No se pudo contabilizar el resultado final',key,e);}
    }
    // El índice de limpieza no depende del contador. Evita escrituras repetidas
    // cuando los observadores reciben varias actualizaciones de la misma partida.
    if(indexedFinals.has(key))return;
    indexedFinals.add(key);
    try {await db.ref(`salasFinalizadas/${code}`).update({
      creadaEn:data.creadaEn, finalizadaEn:data.juego.finalizadaEn||serverNow(),
      creadorUid:data.creadorUid, numeroPartida:Number(data.numeroPartida||1)
    });} catch(e){indexedFinals.delete(key);console.warn('No se pudo indexar la sala finalizada',code,e);}
  }
  async function reserveCreationSlot(code) {
    const list=db.ref(`usuarioSalas/${user.uid}`);
    try {
      const snap=await list.once('value');
      const known=snap.val()||{};
      for(const oldCode of Object.keys(known)) {
        const exists=await db.ref(`salas/${oldCode}`).once('value').then(s=>s.val()).catch(()=>null);
        if(!exists || exists.estado==='cerrada' || Core.shouldDelete(exists,serverNow()))
          await list.child(oldCode).remove().catch(()=>{});
      }
      const result=await list.transaction(value=>{
        value=value||{};
        if(value[code]||Object.keys(value).length>=ROOM_LIMIT)return;
        value[code]=serverNow();return value;
      },undefined,false);
      if(!result.committed)throw new Error('Has alcanzado el máximo de tres salas activas.');
      return true;
    } catch(e) {
      if(!permissionDenied(e))throw e;
      legacyRulesMode=true;
      // Solo en compatibilidad con reglas de v1.01: consultar salas creadas
      // por este usuario. Con reglas nuevas, esta lectura general no se concede.
      try {
        const own=(await db.ref('salas').orderByChild('creadorUid').equalTo(user.uid).once('value')).val()||{};
        const active=Object.values(own).filter(r=>r&&r.estado!=='cerrada'&&!Core.shouldDelete(r,serverNow()));
        if(active.length>=ROOM_LIMIT)throw new Error('Has alcanzado el máximo de tres salas activas.');
      } catch(readError) {
        if(!permissionDenied(readError))throw readError;
        // Si tampoco se permite la consulta, no fingimos que el límite está
        // verificado. Lo advierte la consola, y se intenta crear la sala.
        console.warn('No se pudo comprobar el límite de salas: publica las reglas v1.02.1.',readError);
      }
      return false;
    }
  }
  async function creationCooldown() {
    const ref=db.ref(`limiteUsuarios/${user.uid}/ultimaCreacionEn`);
    const now=serverNow();
    try {
      const result=await ref.transaction(previous=>{
        if(Number(previous||0)>now-CREATE_COOLDOWN_MS)return;
        return now;
      },undefined,false);
      if(!result.committed)throw new Error('Espera 20 segundos antes de crear otra sala.');
    } catch(e) {
      if(!permissionDenied(e))throw e;
      legacyRulesMode=true;
      fallbackCreationCooldown();
    }
  }
  async function commitGame(before, next, guard=()=>true) {
    const expected=Number(before.version||0);
    const action=Core.code()+String(serverNow());
    const result=await db.ref(`salas/${currentCode}/juego`).transaction(actual=>{
      if(!actual || Number(actual.version||0)!==expected || !guard(actual))return;
      return cleanFirebaseValue({...next,version:expected+1,ultimaAccionId:action});
    },undefined,false);
    if(!result.committed)throw new Error('La partida se ha actualizado desde otro dispositivo. Se ha cancelado esta acción para evitar sobrescribir cartas.');
    return result.snapshot.val();
  }
  // Firebase Realtime Database rechaza propiedades con valor undefined.
  // Algunas resoluciones (por ejemplo, una carta Guerrero sin adivinación) podían
  // construir eventoVisual con campos opcionales undefined y bloquear toda la jugada.
  function cleanFirebaseValue(value) {
    if (Array.isArray(value)) return value.map(item => item === undefined ? null : cleanFirebaseValue(item));
    if (value && typeof value === "object") {
      const clean = {};
      Object.entries(value).forEach(([key, item]) => {
        if (item !== undefined && typeof item !== "function") clean[key] = cleanFirebaseValue(item);
      });
      return clean;
    }
    return value;
  }
  function randomCode() { return Core.code(); }
  function validateName(name) { Core.safeName(name); }
  async function ensureUser() {
    if(auth.currentUser) { user=auth.currentUser; return user; }
    const cred=await auth.signInAnonymously();
    user=cred.user; return user;
  }
  function detach() {
    if(roomRef && roomCallback) roomRef.off("value",roomCallback);
    roomRef=null; roomCallback=null;
  }
  async function deleteRoomIfEligible(code, data=null) {
    if(!data){try{data=(await db.ref(`salas/${code}`).once('value')).val();}catch(_){return false;}}
    if(!data)return true;
    if(!Core.shouldDelete(data,serverNow()))return false;
    try {
      await db.ref(`salas/${code}`).remove();
      await db.ref(`salasFinalizadas/${code}`).remove().catch(()=>{});
      return true;
    }catch(e){console.warn('La limpieza no pudo eliminar la sala',code,e);return false;}
  }
  async function expireRoomIfNeeded(code,data) {
    if(!Core.shouldDelete(data,serverNow()))return false;
    await deleteRoomIfEligible(code,data);
    return true;
  }
  async function cleanupExpiredRooms() {
    if(!db||!user)return;
    try {
      // La consulta del servidor solo permite leer salas de más de 48 horas.
      const cutoff=serverNow()-ROOM_TTL_MS-60000; // margen frente al reloj del servidor
      const snap=await db.ref('salas').orderByChild('creadaEn').endAt(cutoff).limitToFirst(50).once('value');
      for(const child of Object.values(snap.val()||{})){
        if(child?.codigo)await deleteRoomIfEligible(child.codigo,child);
      }
    } catch(e){console.warn('La limpieza por antigüedad no está disponible con las reglas actuales.',e);}
    try {
      // Solo las salas FINALIZADAS aparecen en este índice sin cartas privadas.
      const finals=(await db.ref('salasFinalizadas').orderByChild('creadorUid').equalTo(user.uid).once('value')).val()||{};
      for(const [code,info] of Object.entries(finals)) {
        const first=Number(info.primeraSolicitudEn||0);
        const base=first>=Number(info.finalizadaEn||0)?first:Number(info.finalizadaEn||0);
        const deadline=Math.min(Number(info.creadaEn||0)+ROOM_TTL_MS,base+REMATCH_MS);
        if(!base||serverNow()<deadline)continue;
        // La regla del servidor comprueba también que la sala siga finalizada.
        await db.ref(`salas/${code}`).remove().then(()=>db.ref(`salasFinalizadas/${code}`).remove()).catch(()=>{});
      }
    }catch(e){console.warn('La limpieza de partidas finalizadas no pudo completarse.',e);}
  }
  function listen(code) {
    detach(); currentCode=code; roomRef=db.ref(`salas/${code}`);
    try{localStorage.setItem('nexus.ultimaSala',code);}catch(_){}
    roomCallback=snap=>{
      if(!snap.exists()){
        const last=readSavedResult(code);
        detach();room=null;currentCode=null;
        if(last){renderSavedResult(last);say('La sala ya no está disponible. Se conserva el último resultado en este dispositivo.');}
        else{say('La sala ya no existe o ha caducado.');showScreen('pantalla-inicio');}
        return;
      }
      const data=snap.val();
      if(Core.shouldDelete(data,serverNow())){
        expireRoomIfNeeded(code,data).finally(()=>{
          if(currentCode===code){detach();room=null;currentCode=null;showScreen('pantalla-inicio');say('La sala ha caducado.');}
        });return;
      }
      room=data;room.codigo=code;
      if(typeof room.reingresoAbierto!=='boolean')room.reingresoAbierto=true;
      if(room.estado==='jugando')renderGame();else renderLobby();
      if(data.jugadores?.[user?.uid] && data.juego?.estado==='finalizada')
        registerFinishedRoomOnce(code,data).catch(e=>console.warn('Estadística de fin no disponible',e));
    };
    roomRef.on('value',roomCallback,err=>{
      console.warn('No se pudo leer la sala',err);
      const saved=readSavedResult(code);
      detach();room=null;currentCode=null;
      if(saved)renderSavedResult(saved);else{showScreen('pantalla-inicio');say('Ya no tienes acceso a esta sala.');}
    });
    if(user)db.ref(`salas/${code}/jugadores/${user.uid}/conectado`).onDisconnect().set(false).catch(()=>{});
  }
  function playersOf(data=room) { return Object.values(data?.jugadores || {}); }
  function renderLobby() {
    if(!room) return;
    $("codigo-sala").textContent=room.codigo;
    const players=playersOf();
    $("estado-lobby").textContent=`${players.length} de ${room.maxJugadores} jugadores`;
    const list=$("lista-jugadores"); list.replaceChildren();
    players.forEach(p=>{
      const li=document.createElement("li"), name=document.createElement("span");
      name.textContent=p.nombre || "Jugador"; li.appendChild(name);
      if(p.uid===room.creadorUid){const tag=document.createElement("span");tag.className="creador";tag.textContent="ANFITRIÓN";li.appendChild(tag);}
      list.appendChild(li);
    });
    const host=room.creadorUid===user?.uid, canStart=players.length>=2;
    $("btn-iniciar-partida").disabled=!(host && canStart && room.estado==="esperando");
    $("btn-iniciar-partida").textContent=host?"Iniciar partida":"Esperando al anfitrión";
    $("estado-partida").textContent=host?"Puedes iniciar cuando haya al menos 2 jugadores.":"El anfitrión iniciará la partida cuando todos estén listos.";
    showScreen("pantalla-lobby");
  }
  function makeDeck(playerCount=0) {
    // En partidas de dos jugadores se retiran estas 11 cartas del mazo completo.
    // Se excluyen antes de quemar/repartir, por lo que tampoco pueden aparecer en rondas posteriores.
    const ids=Core.cardsForPlayers(Number(playerCount));
    return ids.map((id,i)=>({id,value:Number(id[0]),name:cardName(id),characteristic:CARD_META[id]?.[1]||"Carta",character:CARD_META[id]?.[2]||"",effect:cardEffect(id),image:`assets/cartas/${id}.jpg`,uid:`${id}-${i}`}));
  }
  const CARD_META = {
    "01":[0,"Espíritu animal","El Llorón"],
    "02":[0,"Asesino","La Sombra Errante"],
    "11":[1,"Guerrero","Kael, el Saqueador"],
    "12":[1,"Guerrero","Varek"],
    "13":[1,"Guerrero","Drakor"],
    "14":[1,"Guerrero","Brakk"],
    "15":[1,"Guerrero","Fenrir"],
    "16":[1,"Guerrero","Darius"],
    "17":[1,"Guerrero","Aelyra"],
    "18":[1,"Guerrero","Kaelen"],
    "21":[2,"Curioso","Nira"],
    "22":[2,"Curioso","Orien"],
    "23":[2,"Curioso","Tovin"],
    "31":[3,"Estratega","Qyron"],
    "32":[3,"Estratega","Silas"],
    "33":[3,"Estratega","Zevran"],
    "41":[4,"Aliado","Cormac"],
    "42":[4,"Aliado","Maeve"],
    "43":[4,"Aliado","Jaxen"],
    "51":[5,"Gemelo","Lyra"],
    "52":[5,"Gemelo","Korath"],
    "61":[6,"Rey","Valerius"],
    "62":[6,"Rey","Malikor"],
    "71":[7,"Lady","Vanya"],
    "72":[7,"Lady","Elowen"],
    "81":[8,"Khaleesi","Lyanna"],
    "91":[9,"Dragón","Bahamut"]
  };
  function cardName(id) { const m=CARD_META[String(id)]; return m ? `${m[1]} · ${m[2]}` : `Carta ${id}`; }
  function cardEffect(id) {
    const effects={
      "01":"Elige a un jugador. Si gana la ronda, tú sumas un punto adicional. Aparece una gota azul junto a su nombre durante la ronda.",
      "02":"Si un efecto te fuera a eliminar mientras conservas esta carta, descártala, roba otra carta y no mueres.",
      "11":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado.","12":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado. Si alguien conserva a El Llorón, lo descarta.","13":"Elige un jugador y un valor distinto de 1 u 8. Si aciertas, queda eliminado.","14":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado.","15":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado.","16":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado.","17":"Elige un jugador y un valor distinto de 1. Si aciertas, queda eliminado.",
      "18":"Si un efecto te fuera a eliminar, descarta Kaelen, roba otra carta y no mueres.",
      "21":"Elige un jugador y mira su carta en secreto.","22":"Elige hasta dos jugadores y mira sus cartas. Con dos jugadores en la partida solo puedes mirar la del otro jugador.","23":"Elige un jugador y mira su carta en secreto.",
      "31":"Compara tu carta con la de otro jugador. La de menor valor queda eliminada.","32":"Compara tu carta con la de otro jugador. La de menor valor queda eliminada.","33":"Elige si debe morir la carta mayor o la menor y luego elige un jugador para comparar. Si te atacan con un 3 o un 7 mientras conservas esta carta, puedes redirigir el ataque a otro jugador.",
      "41":"Quedas protegido hasta que vuelva a comenzar tu siguiente turno. No puedes ser elegido como objetivo.","42":"Quedas protegido hasta que vuelva a comenzar tu siguiente turno. No puedes ser elegido como objetivo. Al final de ronda sumas +1 al valor de tu carta.","43":"Quedas protegido hasta que vuelva a comenzar tu siguiente turno. No puedes ser elegido como objetivo.",
      "51":"Elige a otro jugador y comprueba su carta. Si conserva la otra carta de valor 5 (Lyra o Korath), ganas la ronda inmediatamente. Si no tiene el otro 5, debe descartar su carta: si descarta a Lyanna (8), queda eliminado de la ronda; si descarta cualquier otra carta, roba una carta de reemplazo. La carta 5 que has jugado permanece descartada como cualquier carta jugada.","52":"Elige a otro jugador y comprueba su carta. Si conserva la otra carta de valor 5 (Lyra o Korath), ganas la ronda inmediatamente. Si no tiene el otro 5, debe descartar su carta: si descarta a Lyanna (8), queda eliminado de la ronda; si descarta cualquier otra carta, roba una carta de reemplazo. La carta 5 que has jugado permanece descartada como cualquier carta jugada.",
      "61":"Elige a otro jugador e intercambia tu carta con la suya.","62":"Reúne las cartas que conservan todos los jugadores vivos y repártelas de nuevo al azar entre ellos. Si Bahamut te ataca mientras conservas esta carta, el propietario de Bahamut queda eliminado.",
      "71":"Compara tu carta con la de otro jugador. La de mayor valor queda eliminada.","72":"Si conservas un 5 o un 6, debes descartar esta carta. También puedes descartarla voluntariamente.","81":"Si descartas esta carta por el efecto de otra carta o voluntariamente, quedas eliminado de la ronda.","91":"Elige a un jugador no protegido. Si tiene un 8, no ocurre nada. Si tiene a Malikor, muere quien jugó Bahamut; si tiene a Kaelen, este se salva descartándose y robando otra; en otro caso queda eliminado."
    }; return effects[String(id)] || "Consulta las reglas de esta carta.";
  }
  function cardImagePath(card) {
    const id=String(card?.id || '').trim();
    return window.CARD_IMAGE_DATA?.[id] || card?.image || (id ? `assets/cartas/${id}.jpg` : '');
  }
  function makeFallbackCard(card, compact=false) {
    const fallback=document.createElement('div'); fallback.className=compact?'fallback-mini':'fallback-card';
    const value=document.createElement('strong'); value.className='value'; value.textContent=card?.value ?? '?'; fallback.appendChild(value);
    const name=document.createElement(compact?'span':'h3'); name.textContent=card?.name || `Carta ${card?.id || ''}`; fallback.appendChild(name);
    if(!compact){const effect=document.createElement('p');effect.textContent=card?.effect || cardEffect(card?.id);fallback.appendChild(effect);}
    return fallback;
  }
  function makeCardVisual(card, compact=false) {
    const wrap=document.createElement(compact?'div':'button');
    if(!compact){wrap.type='button';wrap.className='playing-card';wrap.addEventListener('dblclick',()=>showCardDetails(card));wrap.title='Pulsa para jugar; doble clic para ampliar la carta';}
    else wrap.className='played-card';
    const path=cardImagePath(card);
    if(path){const img=document.createElement('img');if(!compact)img.className='card-image';img.src=path;img.alt=card?.name||`Carta ${card?.id||''}`;img.loading='lazy';img.onerror=()=>{img.remove();wrap.insertBefore(makeFallbackCard(card,compact),wrap.firstChild);};wrap.appendChild(img);}
    else wrap.appendChild(makeFallbackCard(card,compact));
    if(compact){const copy=document.createElement('div');copy.className='played-card-copy';const name=document.createElement('strong');name.textContent=card?.name||`Carta ${card?.id||''}`;copy.appendChild(name);const number=document.createElement('small');number.textContent=`Número/valor: ${card?.value ?? '—'}`;copy.appendChild(number);const effect=document.createElement('span');effect.textContent=card?.effect||cardEffect(card?.id);copy.appendChild(effect);wrap.appendChild(copy);}
    else {const info=document.createElement('div');info.className='card-info';const value=document.createElement('span');value.className='value';value.textContent=card?.value ?? '?';info.appendChild(value);const name=document.createElement('span');name.className='card-name';name.textContent=card?.name||`Carta ${card?.id||''}`;info.appendChild(name);wrap.appendChild(info);}
    return wrap;
  }
  function showCardDetails(card) {
    const modal=$('modal-carta'),content=$('contenido-modal-carta');if(!modal||!content)return;
    content.replaceChildren();const path=cardImagePath(card);
    if(path){const img=document.createElement('img');img.className='modal-card-image';img.src=path;img.alt=card?.name||'Carta';img.onerror=()=>{img.remove();content.insertBefore(makeFallbackCard(card,false),content.firstChild);};content.appendChild(img);}
    else content.appendChild(makeFallbackCard(card,false));
    const title=document.createElement('h3');title.textContent=card?.name||`Carta ${card?.id||''}`;content.appendChild(title);
    const number=document.createElement('p');number.textContent=`Número/valor: ${card?.value ?? '—'}`;content.appendChild(number);
    const effect=document.createElement('p');effect.textContent=card?.effect||cardEffect(card?.id);content.appendChild(effect);
    modal.classList.remove('hidden');
  }
  function allCards() {
    return Object.keys(CARD_META).map(id=>({id,value:Number(id[0]),name:cardName(id),characteristic:CARD_META[id][1],character:CARD_META[id][2],effect:cardEffect(id),image:`assets/cartas/${id}.jpg`}));
  }
  let catalogIndex=0;
  function showCatalogCard(index) {
    const cards=allCards();catalogIndex=(index+cards.length)%cards.length;
    const card=cards[catalogIndex],modal=$('modal-carta'),content=$('contenido-modal-carta');if(!modal||!content)return;
    catalogDetailReturn = true;
    $('modal-reglas')?.classList.add('hidden');
    content.replaceChildren();
    const image=document.createElement('img');image.className='modal-card-image';image.src=card.image;image.alt=card.name;image.onerror=()=>image.remove();content.appendChild(image);
    const title=document.createElement('h2');title.textContent=`${card.value} · ${card.characteristic} · ${card.character}`;content.appendChild(title);
    const effect=document.createElement('p');effect.textContent=card.effect;content.appendChild(effect);
    const nav=document.createElement('div');nav.className='catalog-navigation';nav.setAttribute('aria-label','Navegación entre cartas');
    const prev=document.createElement('button');prev.className='secondary';prev.textContent='← Carta anterior';prev.onclick=()=>showCatalogCard(catalogIndex-1);
    const next=document.createElement('button');next.className='secondary';next.textContent='Carta siguiente →';next.onclick=()=>showCatalogCard(catalogIndex+1);
    const close=document.createElement('button');close.className='primary';close.textContent='Cerrar';close.onclick=()=>{modal.classList.add('hidden');if(catalogDetailReturn){$('modal-reglas')?.classList.remove('hidden');catalogDetailReturn=false;}};
    nav.append(prev,next);content.appendChild(nav);const closeRow=document.createElement('div');closeRow.className='catalog-close-row';closeRow.appendChild(close);content.appendChild(closeRow);modal.classList.remove('hidden');
  }
  function renderCatalog() {
    const root=$('catalogo-cartas');if(!root)return;root.replaceChildren();
    allCards().forEach((card,index)=>{
      const b=document.createElement('button');b.type='button';b.className='catalog-card';
      const img=document.createElement('img');img.src=card.image;img.alt=card.name;img.onerror=()=>img.remove();b.appendChild(img);
      const title=document.createElement('strong');title.textContent=`${card.value} · ${card.character}`;b.appendChild(title);
      const sub=document.createElement('span');sub.textContent=card.characteristic;b.appendChild(sub);
      b.onclick=()=>showCatalogCard(index);root.appendChild(b);
    });
  }
  function addHistoryEntry(game, text, kind='') {
    if (!game || typeof game !== "object") throw new Error("El estado de la partida no es válido.");
    if (!Array.isArray(game.historial)) game.historial = [];
    game.historial.push({texto:text,timestamp:Date.now(),tipo:kind});
    if(game.historial.length>300)game.historial=game.historial.slice(-300);
  }

  // Normaliza los arrays del estado compartido. Algunas salas creadas con versiones
  // anteriores pueden no contener todavía todos los campos del motor actual.
  function normalizeGameForAction(game, uid) {
    if (!game || typeof game !== "object") throw new Error("No se ha encontrado el estado de la partida.");
    if (!game.manos || typeof game.manos !== "object") game.manos = {};
    if (!Array.isArray(game.manos[uid])) game.manos[uid] = [];
    if (!Array.isArray(game.jugadas)) game.jugadas = [];
    if (!Array.isArray(game.historial)) game.historial = [];
    if (!Array.isArray(game.mazo)) game.mazo = [];
    if (!game.puntos || typeof game.puntos !== "object") game.puntos = {};
    if (!game.protegidos || typeof game.protegidos !== "object") game.protegidos = {};
    if (!game.eliminados || typeof game.eliminados !== "object") game.eliminados = {};
    return game;
  }
  function renderHistory(game) {
    const targets=[$('historial-partida'),$('historial-completo')].filter(Boolean);
    targets.forEach(list=>{list.replaceChildren();(game.historial||[]).slice().reverse().forEach(entry=>{const li=document.createElement('li');if(entry.tipo)li.classList.add('event-'+entry.tipo);const time=document.createElement('time');time.textContent=new Date(entry.timestamp||Date.now()).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',second:'2-digit'});li.appendChild(time);li.appendChild(document.createTextNode(entry.texto||'Acción de la partida'));list.appendChild(li);});});
  }
  let timerInterval=null, timeoutInProgress=false;
  async function handleTimeout() {
    if(timeoutInProgress||!room||!user)return;timeoutInProgress=true;
    try{
      const snap=await db.ref(`salas/${currentCode}`).once('value'),data=snap.val(),g=data?.juego;
      if(!g||g.estado==='finalizada'||g.turnoUid!==user.uid||!g.temporizadorActivo||g.partidaPausada)return;
      const elapsed=serverNow()-Number(g.turnoStartedAt||serverNow()),remaining=Number(g.tiempoRestanteMs??120000)-elapsed;
      if(remaining>0)return;
      const before=structuredClone(g);g.manos[user.uid]=[];g.cartaJugada=true;g.cartaRobada=true;
      addHistoryEntry(g,`${data.jugadores?.[user.uid]?.nombre||'El jugador'} agotó los 2 minutos y queda eliminado de la ronda.`,'effect');
      g.eventoVisual={id:Date.now()+Math.random(),tipo:'ataque',texto:`${data.jugadores?.[user.uid]?.nombre||'El jugador'} agotó el tiempo y queda eliminado de la ronda.`};
      await commitGame(before,g,latest=>latest.turnoUid===user.uid&&latest.estado==='jugando');await endTurn();
    }catch(e){console.warn('No se pudo aplicar el límite de tiempo',e);}
    finally{timeoutInProgress=false;}
  }
  function updateTimerUI(game) {
    const label=$('temporizador-turno'),pause=$('btn-pausar');if(!label||!pause)return;
    const active=!!game.temporizadorActivo&&game.estado!=='finalizada';
    label.classList.toggle('hidden',!active);pause.classList.toggle('hidden',!active);
    pause.textContent=game.partidaPausada?'Reanudar partida':'Pausar partida';
    if(!active){label.textContent='';return;}
    if(game.partidaPausada){label.textContent=`PARTIDA PAUSADA · Quedaban ${formatClock(Number(game.tiempoRestanteMs||120000))}`;return;}
    const elapsed=serverNow()-Number(game.turnoStartedAt||serverNow()),left=Math.max(0,Number(game.tiempoRestanteMs??120000)-elapsed);
    label.textContent=`Tiempo restante: ${formatClock(left)}`;
    if(left<=0&&game.turnoUid===user?.uid)handleTimeout();
  }
  function formatClock(ms){const total=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;}
  async function togglePause() {
    try{
      const snap=await db.ref(`salas/${currentCode}`).once('value'),data=snap.val(),g=data?.juego;
      if(!g||!g.temporizadorActivo||g.estado==='finalizada')return;
      const before=structuredClone(g);
      if(!g.partidaPausada){const elapsed=serverNow()-Number(g.turnoStartedAt||serverNow());g.tiempoRestanteMs=Math.max(0,Number(g.tiempoRestanteMs??120000)-elapsed);g.partidaPausada=true;}
      else {g.partidaPausada=false;g.turnoStartedAt=serverNow();}
      addHistoryEntry(g,g.partidaPausada?'La partida se ha pausado.':'La partida se ha reanudado.');
      await commitGame(before,g,latest=>latest.estado==='jugando');
    }catch(e){fail('No se pudo pausar/reanudar la partida',e);}
  }
  function readSavedResult(code) {
    try { const raw=localStorage.getItem(`nexus.resultado.${code}`); return raw?JSON.parse(raw):null; }
    catch(e){return null;}
  }
  function saveResult(result) {
    try {
      localStorage.setItem(`nexus.resultado.${result.code}`,JSON.stringify(result));
      localStorage.setItem('nexus.ultimoResultado',JSON.stringify(result));
    }catch(e){console.warn('No se pudo guardar el resultado local',e);}
  }
  function buildResult(game) {
    const ranking=Object.values(room.jugadores||{}).map(p=>({name:p.nombre||'Jugador',points:Number(game.puntos?.[p.uid]||0),uid:p.uid})).sort((a,b)=>b.points-a.points);
    return {code:room.codigo,number:Number(room.numeroPartida||1),finishedAt:Number(game.finalizadaEn||serverNow()),ranking};
  }
  function fillRanking(result) {
    const ranking=result.ranking||[];
    const max=ranking[0]?.points||0,winners=ranking.filter(p=>p.points===max);
    $('texto-ganador').textContent=winners.length===1?`Ganador: ${winners[0].name} · ${max} puntos`:`Empate en cabeza: ${winners.map(p=>p.name).join(', ')} · ${max} puntos`;
    const list=$('ranking-final');list.replaceChildren();
    ranking.forEach((p,i)=>{const li=document.createElement('li');li.textContent=`${p.name} — ${p.points} puntos`;if(p.points===max)li.classList.add('rank-winner');list.appendChild(li);});
  }
  function renderSavedResult(result){
    if(!result)return;
    showScreen('pantalla-juego');fillRanking(result);
    $('acciones-finales').replaceChildren();
    const exit=document.createElement('button');exit.className='primary full';exit.textContent='Volver al inicio';
    exit.onclick=()=>leaveRoom();$('acciones-finales').appendChild(exit);
    $('evento-visual')?.classList.add('hidden');$('pantalla-final').classList.remove('hidden');
  }
  function updateRematchClock() {
    if(!room||room.juego?.estado!=='finalizada')return;
    const label=$('acciones-finales')?.querySelector('.rematch-status');
    if(!label)return;
    const deadline=Core.rematchDeadline(room),remaining=Math.max(0,Number(deadline||0)-serverNow());
    const count=Object.values(room.solicitudesRevancha||{}).filter(x=>x?.solicitada).length;
    label.textContent=remaining>0?`Revancha disponible durante ${formatClock(remaining)}. ${count} jugador(es) la han solicitado.`:'El plazo de revancha ha terminado.';
    $('acciones-finales')?.querySelectorAll('[data-rematch-action]').forEach(button=>{if(!remaining)button.disabled=true;});
  }
  function renderFinalRanking(game) {
    const modal=$('pantalla-final');if(!modal)return;
    if(game.estado!=='finalizada'){modal.classList.add('hidden');return;}
    const result=buildResult(game);saveResult(result);$('btn-ultimo-resultado')?.classList.remove('hidden');fillRanking(result);
    const actions=$('acciones-finales');actions.replaceChildren();
    const deadline=Core.rematchDeadline(room),remain=Math.max(0,Number(deadline||0)-serverNow());
    const status=document.createElement('p');status.className='rematch-status';
    const requests=Object.entries(room.solicitudesRevancha||{}).filter(([,r])=>r?.solicitada).map(([uid])=>uid);
    const requested=requests.includes(user?.uid);
    status.textContent=remain>0?`Revancha disponible durante ${formatClock(remain)}. ${requests.length} jugador(es) la han solicitado.`:'El plazo de revancha ha terminado.';
    actions.appendChild(status);
    if(remain>0 && room.jugadores?.[user?.uid]) {
      const replay=document.createElement('button');replay.className='primary full';
      replay.textContent=requested?'Revancha solicitada':'Volver a jugar';replay.disabled=requested;replay.dataset.rematchAction='request';
      replay.onclick=()=>requestRematch();actions.appendChild(replay);
      if(room.creadorUid===user.uid && requested && requests.length>=2) {
        const accept=document.createElement('button');accept.className='primary full';accept.textContent='Iniciar revancha con quienes han aceptado';accept.dataset.rematchAction='start';
        accept.onclick=()=>acceptRematch();actions.appendChild(accept);
      }
    }
    const exit=document.createElement('button');exit.className='secondary full';exit.textContent='Salir';
    exit.onclick=()=>leaveRoom();actions.appendChild(exit);
    $('evento-visual')?.classList.add('hidden');modal.classList.remove('hidden');
  }
  async function requestRematch() {
    try {
      if(!currentCode||!user)throw new Error('No se ha encontrado la sala.');
      const ref=db.ref(`salas/${currentCode}`),data=(await ref.once('value')).val();
      if(!data||!Core.rematchOpen(data,serverNow()))throw new Error('El plazo para solicitar revancha ha terminado.');
      if(!data.jugadores?.[user.uid])throw new Error('No perteneces a esta partida.');
      const own=ref.child(`solicitudesRevancha/${user.uid}`);
      const claim=await own.transaction(old=>old||{solicitada:true,nombre:data.jugadores[user.uid].nombre,timestamp:firebase.database.ServerValue.TIMESTAMP},undefined,false);
      if(!claim.committed && !claim.snapshot.exists())throw new Error('No se registró la solicitud.');
      // La primera petición fija el plazo adicional: pulsar de nuevo no lo prorroga.
      const first=ref.child('primeraSolicitudRevanchaEn');
      await first.transaction(value=>value===null?firebase.database.ServerValue.TIMESTAMP:undefined,undefined,false);
      const firstAt=Number((await first.once('value')).val()||serverNow());
      await db.ref(`salasFinalizadas/${currentCode}`).update({
        creadaEn:data.creadaEn,finalizadaEn:data.juego.finalizadaEn,
        creadorUid:data.creadorUid,primeraSolicitudEn:firstAt,
        numeroPartida:Number(data.numeroPartida||1)
      }).catch(e=>console.warn('No se actualizó el índice de revanchas',e));
      say('Revancha solicitada. Los demás jugadores disponen de 10 minutos desde la primera solicitud.');
    }catch(e){fail('No se pudo solicitar revancha',e);}
  }
  async function acceptRematch() {
    try {
      if(!currentCode||!user)throw new Error('No se ha encontrado la sala.');
      const ref=db.ref(`salas/${currentCode}`);
      let rejection='';
      const result=await ref.transaction(data=>{
        rejection='';
        if(!data){rejection='La sala ya no existe.';return;}
        if(data.creadorUid!==user.uid){rejection='Solo el anfitrión puede iniciar otra partida.';return;}
        if(!data.solicitudesRevancha?.[user.uid]?.solicitada){rejection='El anfitrión también debe pulsar Volver a jugar.';return;}
        if(!Core.rematchOpen(data,serverNow())){rejection='El plazo de revancha ha terminado.';return;}
        const participants=Object.entries(data.jugadores||{})
          .filter(([uid,p])=>p?.conectado===true && data.solicitudesRevancha?.[uid]?.solicitada===true)
          .map(([uid,p])=>({...p,uid}));
        if(participants.length<2){rejection='Se necesitan dos jugadores conectados que hayan solicitado revancha.';return;}
        const deck=Core.shuffle(makeDeck(participants.length)),burned=deck.pop(),hands={},scores={};
        participants.forEach(player=>{hands[player.uid]=[deck.pop()];scores[player.uid]=0;});
        const first=participants[Core.integerBelow(participants.length)];
        const game={ronda:1,mazo:deck,manos:hands,puntos:scores,turnoUid:first.uid,cartaRobada:false,cartaJugada:false,jugadas:[],historial:[],eliminados:{},cartaQuemada:burned,temporizadorActivo:!!data.temporizadorActivo,tiempoRestanteMs:120000,turnoStartedAt:serverNow(),partidaPausada:false,estado:'jugando',version:0};
        addHistoryEntry(game,`Nueva partida. Empieza ${first.nombre}.`);
        data.jugadores=Object.fromEntries(participants.map(player=>[player.uid,player]));
        data.estado='jugando';data.numeroPartida=Number(data.numeroPartida||1)+1;data.juego=game;
        data.solicitudesRevancha=null;data.primeraSolicitudRevanchaEn=null;
        return cleanFirebaseValue(data);
      },undefined,false);
      if(!result.committed)throw new Error(rejection||'La sala ha cambiado. Vuelve a intentarlo.');
      await db.ref(`salasFinalizadas/${currentCode}`).remove().catch(()=>{});
      $('pantalla-final')?.classList.add('hidden');say('La revancha ha comenzado con los jugadores que la solicitaron.');
    }catch(e){fail('No se pudo iniciar la revancha',e);}
  }
  function renderReentryControls() {
    const button=$('btn-reingreso'),panel=$('panel-solicitudes-reingreso');
    if(!button||!room||!user)return;
    const isHost=room.creadorUid===user.uid,open=room.reingresoAbierto!==false;
    button.disabled=!isHost;
    button.classList.toggle('open',open);button.classList.toggle('closed',!open);
    button.textContent=open?'Reingresos abiertos':'Reingresos cerrados';
    button.title=isHost?'Permite o bloquea solicitudes para volver a entrar.':'Solo el anfitrión puede cambiar los reingresos.';
    if(!panel)return;
    panel.replaceChildren();
    const requests=Object.entries(room.solicitudesReingreso||{}).filter(([,r])=>r?.estado==='pendiente');
    if(!isHost||!requests.length){panel.classList.add('hidden');return;}
    panel.classList.remove('hidden');
    const heading=document.createElement('h3');heading.textContent='Solicitudes para volver a entrar';panel.appendChild(heading);
    requests.forEach(([requesterUid,request])=>{
      const row=document.createElement('div');row.className='reentry-request-row';
      const text=document.createElement('p');text.textContent=`${request.nombre||'Jugador'} quiere volver a entrar a la partida.`;row.appendChild(text);
      const accept=document.createElement('button');accept.className='primary';accept.textContent='Aceptar';accept.onclick=()=>resolveReentry(requesterUid,true);row.appendChild(accept);
      const remove=document.createElement('button');remove.className='secondary danger';remove.textContent='Eliminar jugador';remove.onclick=()=>resolveReentry(requesterUid,false);row.appendChild(remove);
      panel.appendChild(row);
    });
  }
  function migratePlayerState(g, oldUid, newUid) {
    if(oldUid===newUid)return;
    const keyed=['manos','puntos','protegidos','eliminados'];
    keyed.forEach(key=>{if(g[key]&&Object.prototype.hasOwnProperty.call(g[key],oldUid)){g[key][newUid]=g[key][oldUid];delete g[key][oldUid];}});
    if(g.apuestasTheon&&Object.prototype.hasOwnProperty.call(g.apuestasTheon,oldUid)){g.apuestasTheon[newUid]=g.apuestasTheon[oldUid];delete g.apuestasTheon[oldUid];}
    Object.keys(g.apuestasTheon||{}).forEach(uid=>{if(g.apuestasTheon[uid]===oldUid)g.apuestasTheon[uid]=newUid;});
    ['turnoUid','forcedWinnerUid','bonusFinalUid'].forEach(key=>{if(g[key]===oldUid)g[key]=newUid;});
    (g.jugadas||[]).forEach(j=>{if(j.uid===oldUid)j.uid=newUid;if(j.objetivoUid===oldUid)j.objetivoUid=newUid;});
  }
  async function resolveReentry(requesterUid, accept) {
    try {
      const ref=db.ref(`salas/${currentCode}`);let reason='';
      const result=await ref.transaction(data=>{
        reason='';
        if(!data||data.creadorUid!==user?.uid){reason='Solo el anfitrión puede resolver reingresos.';return;}
        const request=data.solicitudesReingreso?.[requesterUid];
        if(!request||request.estado!=='pendiente'){reason='La solicitud ya no está pendiente.';return;}
        const oldUid=request.objetivoUid,newUid=request.solicitanteUid;
        if(accept){
          if(oldUid!==newUid){
            const old=data.jugadores?.[oldUid];if(!old){reason='No se encuentra el jugador original.';return;}
            data.jugadores[newUid]={...old,uid:newUid,nombre:request.nombre,conectado:true,reingresoBloqueado:false};
            delete data.jugadores[oldUid];
            if(data.juego)migratePlayerState(data.juego,oldUid,newUid);
          }else if(data.jugadores?.[oldUid]){data.jugadores[oldUid].conectado=true;delete data.jugadores[oldUid].salioEn;}
          request.estado='aceptada';
          if(data.juego)addHistoryEntry(data.juego,`${request.nombre} ha vuelto a entrar en la partida.`,'effect');
        } else {
          if(data.jugadores?.[oldUid]){
            data.jugadores[oldUid].reingresoBloqueado=true;data.jugadores[oldUid].conectado=false;
            if(data.juego?.manos)data.juego.manos[oldUid]=[];
          }
          const g=data.juego;
          if(g&&g.turnoUid===oldUid){
            const alive=Object.values(data.jugadores||{}).filter(p=>p.uid!==oldUid&&(g.manos?.[p.uid]||[]).length);
            if(alive.length){g.turnoUid=alive[0].uid;g.cartaRobada=false;g.cartaJugada=false;
              if(g.temporizadorActivo){g.tiempoRestanteMs=120000;g.turnoStartedAt=serverNow();}}
          }
          if(g)addHistoryEntry(g,`${request.nombre} ha sido eliminado por el anfitrión.`,'warning');
          request.estado='rechazada';
        }
        request.resueltaEn=serverNow();
        if(data.juego)data.juego.version=Number(data.juego.version||0)+1;
        return cleanFirebaseValue(data);
      },undefined,false);
      if(!result.committed)throw new Error(reason||'El estado de la sala ha cambiado.');
    }catch(e){fail('No se pudo resolver el reingreso',e);}
  }
  async function toggleReentry() {
    try {
      if(room?.creadorUid!==user?.uid)return;
      const ref=db.ref(`salas/${currentCode}`),snap=await ref.once('value'),data=snap.val();
      if(!data||data.creadorUid!==user.uid)throw new Error('Solo el anfitrión puede cambiar esta opción.');
      const open=data.reingresoAbierto===false;
      await ref.child('reingresoAbierto').set(open);
      say(open?'Se han abierto los reingresos.':'Se han cerrado los reingresos.');
    }catch(e){fail('No se pudo cambiar el acceso de reingreso',e);}
  }
  function roomInviteUrl() { return `${window.location.origin}${window.location.pathname}?sala=${encodeURIComponent($('codigo-sala')?.textContent||currentCode||'')}`; }
  async function copyText(text, success) { try{await navigator.clipboard.writeText(text);say(success);}catch(_){window.prompt('Copia el texto:',text);} }

  function showHandCardActions(index) {
    const game=room?.juego, mine=(game?.manos||{})[user?.uid]||[], card=mine[index];
    if(!card)return;
    selectedCard=index;showCardDetails(card);
    const content=$('contenido-modal-carta');content.querySelector('.card-actions')?.remove();
    const actions=document.createElement('div');actions.className='card-actions';
    const play=document.createElement('button');play.className='primary full';play.textContent='Jugar esta carta';
    play.addEventListener('click',()=>{ if(playCardBusy||endTurnBusy)return; $('modal-carta').classList.add('hidden'); playCard(index); });actions.appendChild(play);
    const other=document.createElement('button');other.className='secondary full';other.textContent='Ver la otra carta';other.disabled=mine.length<2;
    other.addEventListener('click',()=>showHandCardActions(index===0?1:0));actions.appendChild(other);
    content.appendChild(actions);
  }
  function renderRoundCardCounter(game) {
    const root=$('contador-cartas-ronda');if(!root)return;root.replaceChildren();
    root.classList.toggle('two-player',playersOf().length===2);
    const counts={};Core.cardsForPlayers(playersOf().length).forEach(id=>{const value=Number(id[0]);counts[value]=(counts[value]||0)+1;});
    const played={};(game.jugadas||[]).filter(x=>x.esJugada===true).forEach(x=>{const value=Number(x.carta?.value??String(x.carta?.id||'')[0]);if(Number.isFinite(value))played[value]=(played[value]||0)+1;});
    for(let value=0;value<=9;value++){
      if(!counts[value])continue; // No mostrar valores que no existen en el mazo de dos jugadores.
      const item=document.createElement('div');item.className='round-counter-item';
      const label=document.createElement('strong');label.textContent=String(value);item.appendChild(label);
      const count=document.createElement('span');count.textContent=`${played[value]||0}/${counts[value]||0}`;item.appendChild(count);root.appendChild(item);
    }
  }
  function renderGame() {
    if(!room) return;
    showScreen('pantalla-juego');
    const game=room.juego||{};
    updateTimerUI(game);renderFinalRanking(game);renderReentryControls();
    const currentPlayer=room.jugadores?.[game.turnoUid];
    const turnLabel=$('indicador-turno');if(turnLabel)turnLabel.textContent=game.estado==='finalizada'?'Partida finalizada':(game.turnoUid===user?.uid?'TU TURNO':`Turno de ${currentPlayer?.nombre||'otro jugador'}`);
    $('numero-ronda').textContent=game.ronda||1;
    $('cartas-restantes').textContent=(game.mazo||[]).length;
    $('objetivo-puntos').textContent=game.objetivoPuntos||room.puntosObjetivo||5;
    renderRoundCardCounter(game);
    const zone=$('zona-jugadores');zone.replaceChildren();
    playersOf().forEach(p=>{
      const tile=document.createElement('div');tile.className='player-tile'+(p.uid===game.turnoUid?' active':'')+((game.protegidos||{})[p.uid]?' protected':'');
      const head=document.createElement('div');head.className='player-head';const nameWrap=document.createElement('div');nameWrap.className='player-name-wrap';const n=document.createElement('strong');n.textContent=p.nombre||'Jugador';const dead=(game.manos?.[p.uid]||[]).length===0;if(dead){n.classList.add('player-dead-name');n.title='Eliminado durante esta ronda';}nameWrap.appendChild(n);if((game.protegidos||{})[p.uid]){const prot=document.createElement('span');prot.className='protection-label';prot.textContent='PROTEGIDO';nameWrap.appendChild(prot);}if((game.apuestasTheon||{})[p.uid]){const drop=document.createElement('span');drop.className='teardrop';drop.textContent='💧';drop.title='Si este jugador gana la ronda, el jugador que jugó la carta 0 obtiene un punto adicional.';nameWrap.appendChild(drop);}head.appendChild(nameWrap);const badge=document.createElement('span');badge.className='pill';badge.textContent=p.uid===game.turnoUid?'EN TURNO':'EN MESA';head.appendChild(badge);tile.appendChild(head);
      const score=document.createElement('span');score.className='player-score';score.textContent=`Puntuación: ${(game.puntos||{})[p.uid]||0} / ${room.puntosObjetivo||5}`;tile.appendChild(score);
      const stack=document.createElement('div');stack.className='player-played';const title=document.createElement('span');title.className='played-title';title.textContent='Cartas jugadas';stack.appendChild(title);
      const cards=(game.jugadas||[]).filter(x=>x.uid===p.uid);
      if(!cards.length){const empty=document.createElement('small');empty.className='muted';empty.textContent='Todavía no ha jugado cartas.';stack.appendChild(empty);}
      cards.forEach(x=>{const visual=makeCardVisual(x.carta||{},true);visual.classList.add('played-card-clickable');visual.tabIndex=0;visual.setAttribute('role','button');visual.title='Ver qué ocurrió al jugar esta carta';visual.addEventListener('click',()=>showPlayedDetails(x));visual.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showPlayedDetails(x);}});if(x.cartaVista && x.uid!==user?.uid){/* no revelar la carta vista a otros jugadores */}stack.appendChild(visual);});tile.appendChild(stack);zone.appendChild(tile);
    });
    const hand=$('mi-mano');hand.replaceChildren();const mine=(game.manos||{})[user?.uid]||[];
    mine.forEach((card,index)=>{const b=makeCardVisual(card,false);b.disabled=game.turnoUid!==user?.uid||!game.cartaRobada||!!game.cartaJugada;b.classList.toggle('selected',selectedCard===index);b.addEventListener('click',()=>{if(game.turnoUid===user?.uid&&game.cartaRobada&&!game.cartaJugada){showHandCardActions(index);}else showCardDetails(card);});hand.appendChild(b);});
    const played=$('cartas-jugadas');played.replaceChildren();(game.jugadas||[]).slice().reverse().slice(0,8).forEach(x=>{const item=document.createElement('span');item.className='pill';item.textContent=`${x.nombre}: ${(x.carta||{}).name||'Carta'} (${(x.carta||{}).value??'—'})`;played.appendChild(item);});
    renderHistory(game);
    if(game.estado!=='finalizada')showSharedEvent(game);
    const myTurn=game.turnoUid===user?.uid&&!game.partidaPausada;
    $('btn-robar').disabled=!myTurn||!!game.cartaRobada||!!game.cartaJugada;
    $('btn-pasar').disabled=!myTurn||!game.cartaJugada||endTurnBusy||playCardBusy;
    $('mensaje-turno').textContent=game.estado==='finalizada'?(game.eventoVisual?.texto||'La partida ha terminado.'):(myTurn?(game.cartaRobada?'Elige una carta para leer su efecto antes de jugarla.':'Es tu turno. Roba una carta y después elige cuál jugar.'):'Esperando el turno de otro jugador.');
    if(game.estado==='finalizada'){ $('btn-robar').disabled=true; $('btn-pasar').disabled=true; } if(game.partidaPausada){$('btn-robar').disabled=true;$('btn-pasar').disabled=true;$('mensaje-turno').textContent='Partida pausada por un jugador.';}
  }
  let lastVisualEvent=null, visualTimer=null;
  function showSharedEvent(game) {
    const ev=game.eventoVisual;if(!ev||ev.id===lastVisualEvent)return;
    lastVisualEvent=ev.id;
    const root=$('evento-visual');if(!root)return;
    root.replaceChildren();root.className='event-overlay';
    const close=document.createElement('button');close.className='event-close';close.textContent='×';close.setAttribute('aria-label','Cerrar aviso');close.onclick=()=>root.classList.add('hidden');root.appendChild(close);
    const title=document.createElement('h2');
    title.textContent=ev.tipo==='ronda'?'Resolución de la jugada y fin de ronda':ev.tipo==='comparacion'?'Resolución de la comparación':ev.tipo==='ataque'?'Resolución del ataque':'Resolución de la carta';
    root.appendChild(title);
    if(ev.jugadorNombre){const actor=document.createElement('p');actor.className='event-actor';actor.textContent=`Jugador que ha jugado: ${ev.jugadorNombre}`;root.appendChild(actor);}
    if(ev.carta){const label=document.createElement('h3');label.textContent='Carta jugada';root.appendChild(label);root.appendChild(makeCardVisual(ev.carta,true));}
    if(ev.objetivoNombre){const target=document.createElement('p');target.textContent=`Jugador objetivo: ${ev.objetivoNombre}`;root.appendChild(target);}
    const canSeeComparison=ev.comparacionActorUid===user?.uid||ev.comparacionObjetivoUid===user?.uid;
    if(canSeeComparison&&(ev.cartaComparadaActor||ev.carta2)){const label=document.createElement('h3');label.textContent='Cartas comparadas (solo visibles para los dos jugadores implicados)';root.appendChild(label);if(ev.cartaComparadaActor)root.appendChild(makeCardVisual(ev.cartaComparadaActor,true));if(ev.carta2)root.appendChild(makeCardVisual(ev.carta2,true));}
    if(ev.cartaDescartada){const label=document.createElement('h3');label.textContent='Carta descartada por el efecto';root.appendChild(label);root.appendChild(makeCardVisual(ev.cartaDescartada,true));}
    if(ev.numeroElegido!==undefined){const guess=document.createElement('p');guess.textContent=`Valor adivinado: ${ev.numeroElegido} · ${ev.acierto?'¡Acierto!':'Fallo'}`;root.appendChild(guess);}
    const text=document.createElement('p');text.className='event-resolution';text.textContent=ev.texto||'La carta se ha jugado.';root.appendChild(text);
    // La carta quemada va inmediatamente encima de la puntuación, no al principio del aviso.
    if(ev.cartaQuemada){const label=document.createElement('h3');label.textContent='Carta quemada al inicio de la ronda';root.appendChild(label);root.appendChild(makeCardVisual(ev.cartaQuemada,true));}
    if(ev.puntuaciones){const label=document.createElement('h3');label.textContent='Puntuación actual';root.appendChild(label);const list=document.createElement('ul');Object.entries(ev.puntuaciones).forEach(([uid,pts])=>{const li=document.createElement('li');li.textContent=`${(room?.jugadores?.[uid]?.nombre)||'Jugador'}: ${pts} puntos`;list.appendChild(li);});root.appendChild(list);}
    const done=document.createElement('button');done.className='primary full';done.textContent='Cerrar';done.onclick=()=>root.classList.add('hidden');root.appendChild(done);
    root.classList.remove('hidden');root.classList.add('event-pop');clearTimeout(visualTimer);
  }
  async function createRoom() {
    if(busy)return;busy=true;say('');creationError('');$('btn-generar-partida').disabled=true;
    let reserved=null;
    try {
      const name=Core.safeName($('nombre-creador').value);
      const max=Number($('numero-jugadores').value),target=Number($('puntos-objetivo').value);
      if(!Number.isInteger(max)||max<2||max>8)throw new Error('Elige entre 2 y 8 jugadores.');
      if(!Number.isInteger(target)||target<1||target>20)throw new Error('El objetivo debe estar entre 1 y 20 puntos.');
      await ensureUser();await creationCooldown();
      let code=null;
      for(let i=0;i<10&&!code;i++) {
        const candidate=randomCode(),ref=db.ref(`salas/${candidate}`);
        await reserveCreationSlot(candidate);reserved=candidate;
        const data={codigo:candidate,creadorUid:user.uid,versionCreacion:'1.02',numeroPartida:1,maxJugadores:max,puntosObjetivo:target,temporizadorActivo:$('temporizador-activo')?.value==='si',reingresoAbierto:true,estado:'esperando',creadaEn:firebase.database.ServerValue.TIMESTAMP,jugadores:{[user.uid]:{uid:user.uid,nombre:name,conectado:true,unidoEn:firebase.database.ServerValue.TIMESTAMP}}};
        const claim=await ref.transaction(previous=>previous===null?data:undefined,undefined,false);
        if(claim.committed){code=candidate;break;}
        await db.ref(`usuarioSalas/${user.uid}/${candidate}`).remove().catch(()=>{});reserved=null;
      }
      if(!code)throw new Error('No se pudo crear un código único.');
      await registerCreatedRoomOnce(code);
      listen(code);say('');
      if(legacyRulesMode)console.warn('NEXUS funcionando con reglas Firebase antiguas. Para activar índices, protecciones y contadores, publica firebase-rules.json.');
    }catch(e){
      if(reserved){const exists=await db.ref(`salas/${reserved}`).once('value').then(s=>s.exists()).catch(()=>true);if(!exists)await db.ref(`usuarioSalas/${user.uid}/${reserved}`).remove().catch(()=>{});}
      fail('Error al crear la sala',e);
      creationError(permissionDenied(e)
        ? 'Firebase ha rechazado la creación. Revisa que la autenticación anónima esté activada y publica las reglas incluidas en firebase-rules.json.'
        : String(e?.message||'No se ha podido crear la sala. Comprueba la conexión y vuelve a intentarlo.'));
    }finally{busy=false;$('btn-generar-partida').disabled=false;}
  }
  async function joinRoom() {
    if(busy)return;busy=true;say('');$('btn-unirse').disabled=true;
    const code=$('codigo-partida').value.trim().toUpperCase();
    try {
      const name=Core.safeName($('nombre-jugador').value);
      if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new Error('El código debe tener 6 caracteres válidos.');
      await ensureUser();
      const ref=db.ref(`salas/${code}`);
      let data;
      try { data=(await ref.once('value')).val(); }
      catch(e) {
        if(e.code!=='PERMISSION_DENIED'&&e.code!=='permission_denied')throw e;
        // Para reingresar se consulta solo la ficha pública, NO las manos ni el mazo.
        const paths=['estado','creadaEn','creadorUid','maxJugadores','reingresoAbierto','jugadores'];
        const values=await Promise.all(paths.map(path=>ref.child(path).once('value').then(s=>s.val())));
        data=Object.fromEntries(paths.map((path,i)=>[path,values[i]]));
        if(!data.estado)throw new Error('No existe la sala o no tienes acceso.');
      }
      if(!data)throw new Error('No existe una sala con ese código.');
      if(Core.expired(data.creadaEn,serverNow())){await deleteRoomIfEligible(code,data);throw new Error('La sala ha caducado a las 48 horas.');}
      const existing=data.jugadores||{};
      if(data.estado==='jugando') {
        if(data.juego?.estado==='finalizada'&&!Core.rematchOpen(data,serverNow()))throw new Error('La sala ya ha terminado.');
        const same=existing[user.uid];
        if(same){await ref.child(`jugadores/${user.uid}`).update({conectado:true,salioEn:null});listen(code);return;}
        if(data.juego?.estado==='finalizada')throw new Error('Solo los participantes de la partida pueden solicitar revancha.');
        if(!data.reingresoAbierto)throw new Error('El anfitrión ha cerrado los reingresos.');
        const normalized=name.toLocaleLowerCase('es');
        const previous=Object.values(existing).find(p=>(p.nombre||'').trim().toLocaleLowerCase('es')===normalized);
        if(!previous)throw new Error('Para reingresar utiliza el mismo nombre de la partida.');
        if(previous.reingresoBloqueado)throw new Error('El anfitrión ha bloqueado este jugador.');
        if(previous.conectado)throw new Error('Ese jugador continúa conectado.');
        if(previous.uid===data.creadorUid)throw new Error('El anfitrión debe recuperar su sesión original en el mismo navegador; no se permite apropiarse de ella por nombre.');
        await ref.child(`solicitudesReingreso/${user.uid}`).set({solicitanteUid:user.uid,objetivoUid:previous.uid,nombre:name,estado:'pendiente',solicitadaEn:firebase.database.ServerValue.TIMESTAMP});
        const reqRef=ref.child(`solicitudesReingreso/${user.uid}`);
        const onAnswer=async answer=>{
          const val=answer.val();if(!val)return;
          if(val.estado==='aceptada'){reqRef.off('value',onAnswer);await reqRef.remove().catch(()=>{});listen(code);say('El anfitrión ha aceptado tu reingreso.');}
          if(val.estado==='rechazada'){reqRef.off('value',onAnswer);say('El anfitrión ha rechazado tu reingreso.');}
        };
        reqRef.on('value',onAnswer);say('Solicitud enviada al anfitrión.');return;
      }
      if(data.estado!=='esperando')throw new Error('La sala ya no está disponible.');
      if(!existing[user.uid] && Object.keys(existing).length>=Number(data.maxJugadores))throw new Error('La sala está completa.');
      if(!existing[user.uid])await ref.child(`jugadores/${user.uid}`).set({uid:user.uid,nombre:name,conectado:true,unidoEn:firebase.database.ServerValue.TIMESTAMP});
      else await ref.child(`jugadores/${user.uid}/conectado`).set(true);
      listen(code);
    }catch(e){fail('Error al unirse a la sala',e);}
    finally{busy=false;$('btn-unirse').disabled=false;}
  }
  async function startGame() {
    say('');
    try {
      await ensureUser();
      if(!currentCode)throw new Error('No se ha encontrado la sala.');
      const ref=db.ref(`salas/${currentCode}`);let problem='';
      const result=await ref.transaction(data=>{
        problem='';
        if(!data||data.creadorUid!==user.uid){problem='Solo el anfitrión puede comenzar.';return;}
        if(data.estado!=='esperando'||Core.expired(data.creadaEn,serverNow())){problem='La sala no está disponible.';return;}
        const players=Object.values(data.jugadores||{});
        if(players.length<2){problem='Se necesitan dos jugadores.';return;}
        const deck=Core.shuffle(makeDeck(players.length)),burned=deck.pop(),hands={},scores={};
        players.forEach(player=>{hands[player.uid]=[deck.pop()];scores[player.uid]=0;});
        const first=players[Core.integerBelow(players.length)];
        const game={ronda:1,mazo:deck,manos:hands,puntos:scores,turnoUid:first.uid,cartaRobada:false,cartaJugada:false,jugadas:[],historial:[],eliminados:{},cartaQuemada:burned,temporizadorActivo:!!data.temporizadorActivo,tiempoRestanteMs:120000,turnoStartedAt:serverNow(),partidaPausada:false,estado:'jugando',version:0};
        addHistoryEntry(game,`La partida ha comenzado. Empieza ${first.nombre||'el primer jugador'}.`);
        data.estado='jugando';data.juego=game;return cleanFirebaseValue(data);
      },undefined,false);
      if(!result.committed)throw new Error(problem||'La partida ya ha comenzado.');
    }catch(e){fail('No se pudo iniciar la partida',e);}
  }
  async function drawCard() {
    try {
      const data=(await db.ref(`salas/${currentCode}`).once('value')).val(),g=data?.juego;
      if(!g||g.estado!=='jugando'||g.turnoUid!==user?.uid)throw new Error('No es tu turno.');
      if(Core.expired(data.creadaEn,serverNow()))throw new Error('La sala ha caducado.');
      if(g.partidaPausada)throw new Error('La partida está pausada.');
      const before=structuredClone(g);normalizeGameForAction(g,user.uid);
      if(g.cartaRobada||g.cartaJugada)throw new Error('Ya has robado en este turno.');
      if(!g.mazo.length)throw new Error('No quedan cartas en el mazo.');
      if(!g.manos[user.uid].length)throw new Error('Has sido eliminado de esta ronda.');
      const card=g.mazo.pop();g.manos[user.uid].push(card);g.cartaRobada=true;
      addHistoryEntry(g,`${data.jugadores?.[user.uid]?.nombre||'Un jugador'} roba una carta.`);
      await commitGame(before,g,latest=>latest.turnoUid===user.uid&&!latest.cartaRobada&&!latest.cartaJugada&&latest.estado==='jugando');
    }catch(e){fail('No se pudo robar carta',e);}
  }
  function eligibleTargets(g, data, actorUid, allowProtected=false, excludedUids=[]) {
    const excluded=new Set(excludedUids||[]);
    return Object.values(data.jugadores||{}).filter(p=>p.uid!==actorUid && !excluded.has(p.uid) && (g.manos?.[p.uid]||[]).length>0 && (allowProtected || !(g.protegidos||{})[p.uid]));
  }
  function chooseFromDropdown(title, options, placeholder='Selecciona una opción') {
    return new Promise(resolve=>{
      const modal=$('modal-carta'), content=$('contenido-modal-carta');
      if(!modal||!content){resolve(null);return;}
      content.replaceChildren();
      const h=document.createElement('h2');h.textContent=title;content.appendChild(h);
      const select=document.createElement('select');select.className='choice-select';
      const empty=document.createElement('option');empty.value='';empty.textContent=placeholder;select.appendChild(empty);
      options.forEach(o=>{const opt=document.createElement('option');opt.value=String(o.value);opt.textContent=o.label;select.appendChild(opt);});
      content.appendChild(select);
      const row=document.createElement('div');row.className='button-row';
      const ok=document.createElement('button');ok.className='primary';ok.textContent='Confirmar';
      const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='Cancelar';
      const finish=value=>{modal.classList.add('hidden');content.replaceChildren();resolve(value);};
      ok.onclick=()=>finish(select.value===''?null:select.value);cancel.onclick=()=>finish(null);
      row.append(ok,cancel);content.appendChild(row);modal.classList.remove('hidden');
    });
  }
  async function chooseTarget(g, data, actorUid, promptText='Elige el jugador objetivo', allowProtected=false, entry=null, excludedUids=[]) {
    const targets=eligibleTargets(g,data,actorUid,allowProtected,excludedUids);
    if(!targets.length) {
      if(entry) entry.noEligibleTargets=true;
      return null;
    }
    // Si solo existe un objetivo válido, se selecciona automáticamente.
    // Evita mostrar un selector innecesario en partidas de dos jugadores,
    // cuando quedan dos vivos o cuando la protección deja una única opción.
    if(targets.length===1) {
      if(entry) entry.noEligibleTargets=false;
      return targets[0];
    }
    const picked=await chooseFromDropdown(promptText,targets.map(p=>({value:p.uid,label:p.nombre||'Jugador'})),'Elige un jugador');
    if(entry) entry.noEligibleTargets=false;
    return picked?targets.find(p=>p.uid===picked)||null:null;
  }
  function announce(g, tipo, texto, extra={}) {
    g.eventoVisual={id:Date.now()+Math.random(),tipo,texto,...extra};
  }
  // La consulta privada usa su propio modal: no compite con la ficha de la carta
  // jugada ni con el aviso público de resolución. Solo se crea en el navegador
  // del jugador que ejecuta el efecto y no se guarda en Firebase.
  function showPrivatePeek(seenCards, fallbackName='Jugador') {
    const seen=Array.isArray(seenCards)?seenCards:[{target:{nombre:fallbackName},targetCard:seenCards}];
    if(!seen.length)return;
    let modal=document.getElementById('modal-mirada-privada');
    if(!modal){
      modal=document.createElement('div');modal.id='modal-mirada-privada';modal.className='private-peek-overlay';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','Consulta privada de cartas');
      document.body.appendChild(modal);
    }
    modal.replaceChildren();
    const panel=document.createElement('div');panel.className='private-peek-panel';
    const closeTop=document.createElement('button');closeTop.className='event-close';closeTop.type='button';closeTop.textContent='×';closeTop.setAttribute('aria-label','Cerrar consulta privada');closeTop.onclick=()=>modal.classList.add('hidden');panel.appendChild(closeTop);
    const title=document.createElement('h2');title.textContent='Consulta privada';panel.appendChild(title);
    const note=document.createElement('p');note.textContent='Solo tú puedes ver estas cartas. Cierra esta ventana cuando hayas terminado.';panel.appendChild(note);
    const list=document.createElement('div');list.className='private-peek-cards';
    seen.forEach(item=>{
      if(!item||!item.targetCard)return;
      const section=document.createElement('section');section.className='private-peek-item';
      const name=document.createElement('h3');name.textContent=`Carta de ${item.target?.nombre||fallbackName}`;section.appendChild(name);
      const visual=makeCardVisual(item.targetCard,false);visual.disabled=true;visual.classList.add('private-peek-card');section.appendChild(visual);list.appendChild(section);
    });
    panel.appendChild(list);
    const close=document.createElement('button');close.className='primary full';close.type='button';close.textContent='Cerrar';close.onclick=()=>modal.classList.add('hidden');panel.appendChild(close);
    modal.appendChild(panel);modal.classList.remove('hidden');
  }
  function showPlayedDetails(entry) {
    const modal=$('modal-carta'),content=$('contenido-modal-carta');if(!modal||!content)return;
    content.replaceChildren();const title=document.createElement('h2');title.textContent=`${entry.nombre||'Jugador'} jugó ${entry.carta?.name||`la carta ${entry.carta?.id||''}`}`;content.appendChild(title);
    const card=makeCardVisual(entry.carta||{},false);card.disabled=true;content.appendChild(card);
    const detail=document.createElement('p');detail.textContent=entry.resultado||'Carta jugada.';content.appendChild(detail);
    if(entry.cartaVista){if(entry.uid===user?.uid){const sub=document.createElement('p');sub.textContent=`Carta que viste de ${entry.objetivoNombre||'tu objetivo'}:`;content.appendChild(sub);content.appendChild(makeCardVisual(entry.cartaVista,false));}else{const sub=document.createElement('p');sub.textContent='Carta del objetivo: oculta (solo la puede volver a ver quien jugó la carta).';content.appendChild(sub);const blank=document.createElement('div');blank.className='hidden-card-placeholder';blank.textContent='CARTA OCULTA';content.appendChild(blank);}}
    modal.classList.remove('hidden');
  }
  function eliminateOrSave(g, data, uid, cause, entry) {
    const hand=g.manos?.[uid]||[]; const held=hand[0];
    if(!held) return {saved:false, message:`${data.jugadores?.[uid]?.nombre||'El jugador'} ya estaba eliminado.`};
    if(String(held.id)==="02" || String(held.id)==="18") {
      const discarded=hand.shift();
      if(!Array.isArray(g.jugadas))g.jugadas=[];
      g.jugadas.push({uid,nombre:data.jugadores?.[uid]?.nombre||'Jugador',carta:discarded,esDescarte:true,resultado:`Descartó ${discarded.name} y se salvó del efecto: ${cause}.`});
      const replacement=(g.mazo||[]).pop();g.manos[uid]=replacement?[replacement]:[];
      return {saved:true,message:replacement?`${data.jugadores?.[uid]?.nombre||'El jugador'} descarta ${discarded.name}, roba otra carta y no muere.`:`${data.jugadores?.[uid]?.nombre||'El jugador'} se salva, pero no quedan cartas para robar.`};
    }
    if(!Array.isArray(g.jugadas))g.jugadas=[];
    if(String(held.id)==="81") { g.jugadas.push({uid,nombre:data.jugadores?.[uid]?.nombre||'Jugador',carta:held,esDescarte:true,resultado:`Lyanna fue descartada por un efecto y su jugador queda eliminado.`}); }
    g.manos[uid]=[]; return {saved:false,message:`${data.jugadores?.[uid]?.nombre||'El jugador'} queda eliminado.`};
  }
  async function resolveCardEffect(g, data, actorUid, card, entry) {
    const actorName=(data.jugadores?.[actorUid]||{}).nombre||'Jugador';
    const id=String(card.id), value=Number(card.value??id[0]);
    const addPlayed=(uid,c,result)=>{if(!Array.isArray(g.jugadas))g.jugadas=[];g.jugadas.push({uid,nombre:data.jugadores?.[uid]?.nombre||'Jugador',carta:c,esDescarte:true,resultado:result,timestamp:Date.now()});};
    if(id==='01'){
      const target=await chooseTarget(g,data,actorUid,'El Llorón: elige a cualquier jugador vivo al que llorar, incluso si está protegido.',true,entry);
      if(target){g.apuestasTheon=g.apuestasTheon||{};g.apuestasTheon[target.uid]=actorUid;entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;entry.resultado=`${actorName} llora por ${target.nombre}. Si gana la ronda, ${actorName} obtiene un punto adicional.`;announce(g,'carta',entry.resultado,{carta:card});}else{entry.cancelled=true;entry.resultado='No se eligió un jugador. La carta no se ha jugado.';}
      return;
    }
    if(id==='02'){entry.resultado='La Sombra Errante queda descartada. Su habilidad defensiva se aplica si un efecto intenta eliminar a quien la conserva.';return;}
    if(value===1){
      const target=await chooseTarget(g,data,actorUid,'Guerrero: elige un jugador para adivinar su carta.',false,entry);if(!target){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}
      const raw=await chooseFromDropdown('Adivina el valor de la carta de '+(target.nombre||'tu objetivo'),[0,2,3,4,5,6,7,8,9].filter(n=>id!=='13'||n!==8).map(n=>({value:n,label:String(n)})),'Elige un valor (no se puede elegir 1)');if(raw===null){entry.cancelled=true;entry.resultado='Adivinación cancelada. La carta no se ha jugado.';return;}
      const guess=Number(raw);
      const targetCard=(g.manos?.[target.uid]||[])[0];if(!targetCard)throw new Error('El jugador seleccionado ya no tiene una carta en la mano.');const targetValue=Number(targetCard.value??String(targetCard.id)[0]);const hit=targetValue===guess;entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;entry.numeroElegido=guess;
      if(hit){const res=eliminateOrSave(g,data,target.uid,`ataque de ${actorName}`,entry);entry.resultado=`${actorName} eligió ${target.nombre} y adivinó ${guess}: acierto. ${res.message}`;}else entry.resultado=`${actorName} eligió ${target.nombre} y adivinó ${guess}: fallo.`;
      if(id==='12'){
        for(const [uid,cards] of Object.entries(g.manos||{})){
          const lloron=(cards||[]).find(c=>String(c.id)==='01');
          if(!lloron)continue;
          g.manos[uid]=(g.manos[uid]||[]).filter(c=>c!==lloron);
          addPlayed(uid,lloron,`${data.jugadores?.[uid]?.nombre||'Jugador'} descarta a El Llorón por Varek.`);
          const replacement=(g.mazo||[]).pop();
          if(replacement)g.manos[uid].push(replacement);
          entry.resultado+=` El Llorón de ${data.jugadores?.[uid]?.nombre||'un jugador'} fue descartado${replacement?' y reemplazado':''}.`;
        }
      }
      addHistoryEntry(g,entry.resultado,'effect');announce(g,'ataque',entry.resultado,{carta:card,numeroElegido:guess,acierto:hit});return;
    }
    if(value===2){
      const requestedCount=id==='22'?2:1;
      // Orien solo puede mirar jugadores distintos y nunca pregunta por un segundo
      // objetivo cuando solo queda un rival elegible (partida de dos jugadores).
      const available=eligibleTargets(g,data,actorUid,false);
      const count=Math.min(requestedCount,available.length);const seen=[];
      // Si no hay ningún rival seleccionable (porque solo queda el propio jugador
      // o porque el único rival vivo está protegido), la carta se juega y se
      // descarta normalmente, pero su efecto no hace nada.
      if(count===0){
        entry.resultado=`${actorName} juega ${card.name||'la carta 2'}, pero no hay ningún jugador válido al que mirar. La carta se descarta sin efecto.`;
        entry.cartasVistas=[];
        addHistoryEntry(g,entry.resultado,'effect');
        announce(g,'carta',entry.resultado,{carta:card});
        return;
      }
      for(let i=0;i<count;i++){
        const excluded=seen.map(x=>x.target.uid);
        const target=await chooseTarget(g,data,actorUid,`Curioso: elige al jugador ${i+1} de ${count} cuya carta quieres ver en secreto.`,false,entry,excluded);
        if(!target){if(i===0){entry.cancelled=true;entry.resultado='No se eligió ningún jugador. La carta no se ha jugado.';}break;}
        const targetCard=(g.manos?.[target.uid]||[])[0];
        if(targetCard){seen.push({target,targetCard});entry.cartaVista=targetCard;entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;}
      }
      entry.cartasVistas=seen.map(x=>({uid:x.target.uid,nombre:x.target.nombre,carta:x.targetCard}));
      if(!seen.length){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}
      entry.resultado=`${actorName} miró en secreto la carta de ${seen.map(x=>x.target.nombre).join(' y ')}.`;
      addHistoryEntry(g,entry.resultado,'effect');announce(g,'carta',`${entry.resultado} Solo ${actorName} puede verlas.`,{carta:card});
      // Se abre después de reunir todas las cartas elegidas, incluido el caso Orien.
      if(seen.length)showPrivatePeek(seen);
      return;
    }
    if(value===3||id==='71'){
      let dieRule=id==='71'?'higher':'lower';if(id==='33'){const answer=await chooseFromDropdown('Zevran: ¿qué carta debe morir?',[{value:'mayor',label:'La carta de mayor valor'},{value:'menor',label:'La carta de menor valor'}],'Elige una opción');if(answer===null){entry.cancelled=true;entry.resultado='Comparación cancelada. La carta no se ha jugado.';return;}dieRule=answer==='mayor'?'higher':'lower';}
      let target=await chooseTarget(g,data,actorUid,`Estratega: elige a un jugador para comparar (muere la carta ${dieRule==='higher'?'mayor':'menor'}).`,false,entry);if(!target){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}
      // Zevran (33) permite redirigir un ataque de valor 3 o 7 si lo conserva
      // el objetivo inicial. En esta versión, el selector aparece en el dispositivo
      // que está resolviendo la jugada; en partidas presenciales el jugador de Zevran
      // debe indicar su decisión al atacante. Una autorización remota real requiere backend.
      const heldByTarget=(g.manos?.[target.uid]||[])[0];
      if(String(heldByTarget?.id)==='33' && (value===3 || id==='71')){
        const redirect=await chooseTarget(g,data,actorUid,`${target.nombre} conserva a Zevran y puede redirigir el ataque. Elige el nuevo objetivo indicado por ese jugador.`,false,null,[target.uid,actorUid]);
        if(redirect){entry.cartaRevelada=heldByTarget;entry.redirigidoPor=target.nombre;entry.objetivoOriginalNombre=target.nombre;target=redirect;entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;entry.resultado=`Zevran de ${entry.redirigidoPor} redirige el ataque hacia ${target.nombre}.`;}
      }
      const mine=(g.manos?.[actorUid]||[])[0],theirs=(g.manos?.[target.uid]||[])[0];if(!mine||!theirs){entry.resultado='No se pudo comparar: falta una carta.';return;}
      const mv=Number(mine.value)+(id==='42'?1:0),tv=Number(theirs.value);let loser=null;if(mv!==tv)loser=(dieRule==='higher'?(mv>tv?actorUid:target.uid):(mv<tv?actorUid:target.uid));
      entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;entry.cartaComparadaActor=mine;entry.cartaComparada=theirs;
      entry.comparacionActorUid=actorUid;entry.comparacionObjetivoUid=target.uid;
      const redirectPrefix=entry.redirigidoPor?`Zevran de ${entry.redirigidoPor} redirigió el ataque. `:'';if(loser){const res=eliminateOrSave(g,data,loser,`comparación de ${actorName}`,entry);entry.resultado=`${redirectPrefix}Comparación resuelta entre ${actorName} y ${target.nombre}. ${res.message}`;}else entry.resultado=`${redirectPrefix}Comparación entre ${actorName} y ${target.nombre}: empate; nadie muere.`;
      addHistoryEntry(g,entry.resultado,'effect');announce(g,'comparacion',entry.resultado,{comparacionActorUid:actorUid,comparacionObjetivoUid:target.uid,cartaComparadaActor:mine,carta2:theirs});return;
    }
    if(value===4){g.protegidos=g.protegidos||{};g.protegidos[actorUid]=true;if(id==='42'){g.bonusFinalUid=actorUid;}entry.resultado=`${actorName} queda PROTEGIDO hasta que vuelva a comenzar su turno.`;addHistoryEntry(g,entry.resultado,'effect');announce(g,'carta',entry.resultado,{carta:card});return;}
    if(value===5){
      const target=await chooseTarget(g,data,actorUid,'Gemelo: elige un jugador.',false,entry);if(!target){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}const held=(g.manos?.[target.uid]||[])[0];entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;if(!held){entry.resultado=`${target.nombre} ya está eliminado.`;return;}
      if(Number(held.value)===5){g.forcedWinnerUid=actorUid;entry.resultado=`${target.nombre} tenía el otro 5. ${actorName} gana la ronda.`;announce(g,'ronda',entry.resultado,{carta:card});}
      else {addPlayed(target.uid,held,`${target.nombre} descarta ${held.name} por el efecto de ${actorName}.`);entry.cartaDescartada=held;if(Number(held.value)===8){g.manos[target.uid]=[];entry.resultado=`${target.nombre} descarta a Lyanna (8) y queda eliminado.`;}else{const replacement=(g.mazo||[]).pop();g.manos[target.uid]=replacement?[replacement]:[];entry.resultado=replacement?`${target.nombre} descarta ${held.name} y roba una carta de reemplazo.`:`${target.nombre} descarta ${held.name}, pero no quedan cartas para robar; queda eliminado.`;}announce(g,'carta',entry.resultado,{carta:held});}addHistoryEntry(g,entry.resultado,'effect');return;
    }
    if(id==='62'){
      const alive=Object.keys(data.jugadores||{}).filter(uid=>(g.manos?.[uid]||[]).length>0);const pool=Core.shuffle(alive.map(uid=>g.manos[uid][0]));alive.forEach((uid,i)=>g.manos[uid]=[pool[i]]);entry.resultado=`${actorName} jugó al Malikor: las cartas de los jugadores vivos se repartieron de nuevo al azar.`;addHistoryEntry(g,entry.resultado,'effect');announce(g,'carta',entry.resultado,{carta:card});return;
    }
    if(id==='61'){
      const target=await chooseTarget(g,data,actorUid,'Valerius: elige a un jugador para intercambiar las cartas.',false,entry);if(!target){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}const mine=(g.manos?.[actorUid]||[])[0],theirs=(g.manos?.[target.uid]||[])[0];if(mine&&theirs){g.manos[actorUid]=[theirs];g.manos[target.uid]=[mine];entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;entry.resultado=`${actorName} intercambió su carta con ${target.nombre}.`;announce(g,'carta',entry.resultado,{carta:card});}return;
    }
    if(id==='72') {const hand=g.manos?.[actorUid]||[];const other=hand[0];if([5,6].includes(Number(other?.value))){entry.resultado=`Elowen se descarta obligatoriamente porque conservas un ${other.value}.`;}else{const ans=window.confirm('¿Quieres descartar Elowen voluntariamente? Pulsa Aceptar para descartarla o Cancelar para conservarla.');if(!ans){entry.cancelled=true;entry.resultado='Elowen se conserva en la mano.';return;}}return;}
    if(id==='81'){g.manos[actorUid]=[];entry.resultado=`${actorName} descarta voluntariamente a Lyanna (8) y queda eliminado de la ronda.`;addHistoryEntry(g,entry.resultado,'effect');announce(g,'carta',entry.resultado,{carta:card});return;}
    if(id==='91'){
      const target=await chooseTarget(g,data,actorUid,'Bahamut: elige un jugador no protegido para atacar.',false,entry);if(!target){entry.cancelled=true;entry.resultado='No se eligió objetivo. La carta no se ha jugado.';return;}const held=(g.manos?.[target.uid]||[])[0];entry.objetivoUid=target.uid;entry.objetivoNombre=target.nombre;
      if(String(held?.id)==='62'){g.manos[actorUid]=[];entry.resultado=`${target.nombre} revela a Malikor: el poder de Bahamut se vuelve contra ${actorName}, que queda eliminado.`;}
      else if(Number(held?.value)===8)entry.resultado=`${target.nombre} tiene a Lyanna (8): Bahamut no puede eliminarlo.`;
      else if(String(held?.id)==='18'){const res=eliminateOrSave(g,data,target.uid,'ataque de Bahamut',entry);entry.resultado=`${target.nombre} tenía a Kaelen. ${res.message}`;}
      else {const res=eliminateOrSave(g,data,target.uid,`ataque de Bahamut de ${actorName}`,entry);entry.resultado=res.message;}
      addHistoryEntry(g,entry.resultado,'effect');announce(g,'ataque',entry.resultado,{carta:card});return;
    }
  }
  async function playCard(index) {
    if(playCardBusy || endTurnBusy)return;
    playCardBusy=true;
    try {
      const snap=await db.ref(`salas/${currentCode}`).once("value"), data=snap.val(), g=data?.juego;
      if(!g||g.estado!=='jugando'||g.turnoUid!==user.uid) throw new Error("No es tu turno."); if(g.partidaPausada)throw new Error("La partida está pausada.");
      const before=structuredClone(g);normalizeGameForAction(g,user.uid);
      if(!g.cartaRobada) throw new Error("Primero debes robar una carta.");
      if(g.cartaJugada) throw new Error("Ya has jugado una carta en este turno.");
      g.manos=g.manos||{};g.manos[user.uid]=Array.isArray(g.manos[user.uid])?g.manos[user.uid]:[];g.jugadas=Array.isArray(g.jugadas)?g.jugadas:[];g.historial=Array.isArray(g.historial)?g.historial:[];g.protegidos=g.protegidos||{};g.apuestasTheon=g.apuestasTheon||{};
      const hand=g.manos[user.uid];
      if(index<0||index>=hand.length) throw new Error("La carta seleccionada ya no está en tu mano.");
      const card=hand.splice(index,1)[0];
      card.value=Number(card.value??String(card.id)[0]);card.name=cardName(card.id);card.characteristic=CARD_META[String(card.id)]?.[1]||"Carta";card.character=CARD_META[String(card.id)]?.[2]||"";card.effect=cardEffect(card.id);
      const playerName=(data.jugadores?.[user.uid]||{}).nombre||"Jugador";
      const entry={uid:user.uid,nombre:playerName,carta:card,esJugada:true,resultado:`${playerName} jugó ${card.name||`la carta ${card.id||""}`}.`,timestamp:Date.now()};
      g.jugadas.push(entry);g.cartaJugada=true;g.manos[user.uid]=hand;g.ultimaCartaJugada=card;
      addHistoryEntry(g,`${playerName} juega ${card.name||`la carta ${card.id||""}`} (valor ${card.value??"—"}).`,"effect");
      // Aplicar el efecto real de la carta antes de guardar el estado compartido.
      await resolveCardEffect(g,data,user.uid,card,entry);
      // Sin objetivos válidos (por ejemplo, todos los rivales están protegidos), la carta se descarta
      // sin efecto y el turno continúa. Si el jugador cancela un selector con opciones, vuelve a su mano.
      if(entry.cancelled && entry.noEligibleTargets){
        entry.cancelled=false;
        entry.resultado='No hay jugadores válidos a los que aplicar este efecto (todos están protegidos o eliminados). La carta se descarta sin efecto.';
        addHistoryEntry(g,entry.resultado,'effect');
        announce(g,'carta',entry.resultado,{carta:card});
      } else if(entry.cancelled){
        g.jugadas=g.jugadas.filter(x=>x!==entry);
        g.manos[user.uid]=[...(g.manos[user.uid]||[]),card];
        g.cartaJugada=false;
        addHistoryEntry(g,entry.resultado||'Acción cancelada; la carta vuelve a la mano.','warning');
        selectedCard=null;
        say(entry.resultado||'Acción cancelada. Puedes volver a intentarlo.');
        return;
      }
      delete entry.noEligibleTargets;
      // Public resolution contains only information that may be shown to everyone.
      // Secret card peeks are intentionally excluded.
      const resolutionEvent={
        id:Date.now()+Math.random(),tipo:entry.numeroElegido!==undefined?'ataque':(entry.cartaComparada?'comparacion':'carta'),
        jugadorUid:user.uid,jugadorNombre:playerName,carta:card,
        objetivoNombre:entry.objetivoNombre||'',
        comparacionActorUid:entry.comparacionActorUid||null,
        comparacionObjetivoUid:entry.comparacionObjetivoUid||null,
        cartaComparadaActor:entry.cartaComparadaActor||null,
        carta2:entry.cartaComparada||null,
        cartaDescartada:entry.cartaDescartada||null,
        cartaRevelada:entry.cartaRevelada||null,
        numeroElegido:entry.numeroElegido,
        acierto:entry.numeroElegido!==undefined ? String(entry.resultado||'').toLowerCase().includes('adivinó') && String(entry.resultado||'').toLowerCase().includes('acierto') : undefined,
        texto:entry.resultado||`${playerName} jugó ${card.name||'una carta'}.`
      };
      // Never publish private peeks inside the shared room state.
      delete entry.cartaVista;delete entry.cartasVistas;
      // The comparison cards are kept only in the transient event, never in the public played-card history.
      if(entry.cartaComparadaActor||entry.cartaComparada){delete entry.cartaComparadaActor;delete entry.cartaComparada;}
      g.ultimaResolucionPublica=resolutionEvent;
      g.eventoVisual=resolutionEvent;
      await commitGame(before,g,latest=>latest.turnoUid===user.uid&&latest.cartaRobada&&!latest.cartaJugada&&latest.estado==='jugando');selectedCard=null;
      // El efecto se guarda primero; después se avanza automáticamente al siguiente turno.
      await endTurn(true);
    } catch(e){fail("No se pudo jugar la carta",e);}
    finally {playCardBusy=false;if(room?.juego)renderGame();}
  }
  async function endTurn(autoAfterPlay=false) {
    if(endTurnBusy || (playCardBusy && !autoAfterPlay))return;
    endTurnBusy=true;
    const passButton=$("btn-pasar");if(passButton)passButton.disabled=true;
    try {
      const snap=await db.ref(`salas/${currentCode}`).once("value"), data=snap.val(), g=data?.juego;
      if(!g||g.estado!=='jugando'||g.turnoUid!==user.uid) throw new Error("No es tu turno."); if(g.partidaPausada)throw new Error("La partida está pausada.");
      if(!g.cartaJugada) throw new Error("Debes robar y jugar una carta antes de terminar el turno.");
      const before=structuredClone(g);
      const lastResolution=g.ultimaResolucionPublica||g.eventoVisual||null;
      const players=Object.values(data.jugadores||{}), index=players.findIndex(p=>p.uid===user.uid);
      const aliveNow=players.filter(p=>(g.manos?.[p.uid]||[]).length>0);
      const candidates=players.length ? Array.from({length:players.length},(_,step)=>players[(index+step+1)%players.length]).filter(p=>(g.manos?.[p.uid]||[]).length>0) : [];
      const next=candidates[0] || aliveNow[0] || players[(index+1+players.length)%Math.max(players.length,1)];
      if(!next) throw new Error("No hay jugadores disponibles para continuar la partida.");
      addHistoryEntry(g,`${(data.jugadores[user.uid]||{}).nombre||"El jugador"} termina su turno. Ahora juega ${(next||{}).nombre||"el siguiente jugador"}.`);
      g.turnoUid=next.uid; g.cartaRobada=false; g.cartaJugada=false; if(g.temporizadorActivo){g.tiempoRestanteMs=120000;g.turnoStartedAt=serverNow();}
      // La protección dura hasta que vuelve a empezar el turno de ese jugador.
      if(g.protegidos?.[next.uid]) delete g.protegidos[next.uid];
      // Cada jugador mantiene una carta en la mano. Las cartas jugadas quedan visibles en la mesa.
      if((g.manos[user.uid]||[]).length>1) g.manos[user.uid]=[g.manos[user.uid][g.manos[user.uid].length-1]];
      const livingNow=players.filter(p=>(g.manos?.[p.uid]||[]).length>0);
      if(livingNow.length===1) g.forcedWinnerUid=livingNow[0].uid;
      if((g.mazo||[]).length===0 || g.forcedWinnerUid) {
        const alive=players.filter(p=>(g.manos[p.uid]||[]).length>0);
        let high=-1, winners=[];
        alive.forEach(p=>{const c=(g.manos[p.uid]||[])[0],v=Number(c?.value??0)+((g.bonusFinalUid===p.uid)?1:0);if(v>high){high=v;winners=[p];}else if(v===high)winners.push(p);});
        if(g.forcedWinnerUid && data.jugadores?.[g.forcedWinnerUid]) winners=[data.jugadores[g.forcedWinnerUid]];
        if(winners.length===1) {
          const winner=winners[0];g.puntos=g.puntos||{};g.puntos[winner.uid]=(g.puntos[winner.uid]||0)+1;
          Object.entries(g.apuestasTheon||{}).forEach(([targetUid,bonusUid])=>{if(targetUid===winner.uid && bonusUid!==winner.uid)g.puntos[bonusUid]=(g.puntos[bonusUid]||0)+1;});
          addHistoryEntry(g,`${winner.nombre} gana la ronda y suma un punto.`,'round');
          g.eventoVisual={...(lastResolution||{}),id:Date.now()+Math.random(),tipo:'ronda',nombre:winner.nombre,cartaQuemada:g.cartaQuemada||null,texto:`${lastResolution?.texto||'Se ha resuelto la última carta jugada.'}\n\nFin de ronda: ${winner.nombre} gana la ronda con una carta de valor ${high}.`,puntuaciones:{...g.puntos}};
          let objective=Number(g.objetivoPuntos||data.puntosObjetivo||5);
          let atObjective=players.filter(p=>Number(g.puntos[p.uid]||0)>=objective);
          if(atObjective.length>1){
            do { objective++; atObjective=players.filter(p=>Number(g.puntos[p.uid]||0)>=objective); } while(atObjective.length>1 && objective<1000);
            g.objetivoPuntos=objective;
            addHistoryEntry(g,`Empate en la puntuación objetivo: el objetivo sube a ${objective} puntos para todos los jugadores.`,'round');
            g.eventoVisual.texto+=`\n\nEmpate en la puntuación objetivo. El objetivo aumenta a ${objective} puntos para todos.`;
          }
          if(atObjective.length===1) {
            const matchWinner=atObjective[0];g.estado='finalizada';g.finalizadaEn=firebase.database.ServerValue.TIMESTAMP;
            g.eventoVisual.texto+=`\n\n¡${matchWinner.nombre} gana la partida! Ha alcanzado ${g.puntos[matchWinner.uid]} puntos (objetivo: ${objective}).`;
          } else {
            g.ronda=(g.ronda||1)+1;
            const newDeck=Core.shuffle(makeDeck(players.length)), newHands={};
            g.cartaQuemada=newDeck.pop();
            players.forEach(p=>{newHands[p.uid]=[newDeck.pop()];});
            g.mazo=newDeck;g.manos=newHands;g.cartaRobada=false;g.cartaJugada=false;g.jugadas=[];g.protegidos={};g.apuestasTheon={};g.eliminados={};g.forcedWinnerUid=null;g.bonusFinalUid=null;g.turnoUid=players[Core.integerBelow(players.length)].uid;if(g.temporizadorActivo){g.tiempoRestanteMs=120000;g.turnoStartedAt=serverNow();g.partidaPausada=false;}
          }
        } else {
          addHistoryEntry(g,'La ronda termina en empate; no se asigna punto.','round');
          g.eventoVisual={...(lastResolution||{}),id:Date.now()+Math.random(),tipo:'ronda',cartaQuemada:g.cartaQuemada||null,texto:`${lastResolution?.texto||'Se ha resuelto la última carta jugada.'}\n\nFin de ronda: la ronda termina en empate. Nadie suma puntos.`,puntuaciones:{...(g.puntos||{})}};
          g.ronda=(g.ronda||1)+1;const newDeck=Core.shuffle(makeDeck(players.length)),newHands={};g.cartaQuemada=newDeck.pop();players.forEach(p=>newHands[p.uid]=[newDeck.pop()]);
          g.mazo=newDeck;g.manos=newHands;g.cartaRobada=false;g.cartaJugada=false;g.jugadas=[];g.protegidos={};g.apuestasTheon={};g.eliminados={};g.forcedWinnerUid=null;g.bonusFinalUid=null;g.turnoUid=players[Core.integerBelow(players.length)].uid;if(g.temporizadorActivo){g.tiempoRestanteMs=120000;g.turnoStartedAt=serverNow();g.partidaPausada=false;}
        }
      }
      await commitGame(before,g,latest=>latest.turnoUid===user.uid&&latest.cartaJugada&&latest.estado==='jugando');

    } catch(e){fail("No se pudo terminar el turno",e);}
    finally {endTurnBusy=false;if(room?.juego)renderGame();}
  }
  function leaveRoom() {
    // Navegar primero: nunca bloquear el botón por latencia, permisos o desconexión de Firebase.
    const code=currentCode, uid=user?.uid, oldRef=roomRef;
    detach(); currentCode=null; room=null; selectedCard=null;
    try{localStorage.removeItem('nexus.ultimaSala');}catch(_){}
    clearTimeout(visualTimer); lastVisualEvent=null;
    ['pantalla-final','evento-visual','modal-carta','modal-historial'].forEach(id=>$(id)?.classList.add('hidden'));
    say(''); showScreen('pantalla-inicio');
    if(!code || !uid || !db)return;
    // Cancelar la operación de desconexión de la sala abandonada.
    oldRef?.child(`jugadores/${uid}/conectado`).onDisconnect().cancel().catch(e=>console.warn('No se pudo cancelar onDisconnect',e));
    (async()=>{
      try {
        const ref=db.ref(`salas/${code}`);
        const snap=await ref.once('value'), data=snap.val();
        if(!data?.jugadores?.[uid])return;
        if(data.estado==='jugando' || data.creadorUid===uid)
          await ref.child(`jugadores/${uid}`).update({conectado:false,salioEn:firebase.database.ServerValue.TIMESTAMP});
        else await ref.child(`jugadores/${uid}`).remove();
        if(data.creadorUid===uid&&data.estado!=='jugando'){
          await ref.update({estado:'cerrada'});
          await db.ref(`usuarioSalas/${uid}/${code}`).remove().catch(()=>{});
        }
      }catch(e){console.warn('La salida visual se completó; no se pudo actualizar la sala en Firebase:',e);}
    })();
  }
  function wire() {
    $("cerrar-modal-carta")?.addEventListener("click",()=>{ $("modal-carta")?.classList.add("hidden"); if(catalogDetailReturn){$("modal-reglas")?.classList.remove("hidden");catalogDetailReturn=false;} });
    $("modal-carta")?.addEventListener("click",e=>{if(e.target.id==="modal-carta"){e.currentTarget.classList.add("hidden");if(catalogDetailReturn){$("modal-reglas")?.classList.remove("hidden");catalogDetailReturn=false;}}});
    $("btn-historial")?.addEventListener("click",()=>$("modal-historial")?.classList.remove("hidden"));
    $("cerrar-modal-historial")?.addEventListener("click",()=>$("modal-historial")?.classList.add("hidden"));
    $("btn-reglas")?.addEventListener("click",()=>{renderCatalog();$("modal-reglas")?.classList.remove("hidden");});
    $("btn-ver-cartas")?.addEventListener("click",()=>{renderCatalog();$("modal-reglas")?.classList.remove("hidden");});
    $("btn-como-jugar")?.addEventListener("click",()=>$("modal-como-jugar")?.classList.remove("hidden"));
    $("cerrar-reglas")?.addEventListener("click",()=>$("modal-reglas")?.classList.add("hidden"));
    $("cerrar-como-jugar")?.addEventListener("click",()=>$("modal-como-jugar")?.classList.add("hidden"));
    $("btn-crear-partida").addEventListener("click",()=>{say("");showScreen("pantalla-crear");});
    $("btn-unirse-partida").addEventListener("click",()=>{say("");showScreen("pantalla-unirse");});
    $('btn-ultimo-resultado')?.addEventListener('click',()=>{
      try{const data=JSON.parse(localStorage.getItem('nexus.ultimoResultado')||'null');if(data)renderSavedResult(data);}
      catch(e){say('No se ha podido recuperar el último resultado.');}
    });
    $("btn-volver-inicio-crear").addEventListener("click",()=>showScreen("pantalla-inicio"));
    $("btn-volver-inicio-unirse").addEventListener("click",()=>showScreen("pantalla-inicio"));
    $("numero-jugadores").addEventListener("change",()=>{$("puntos-objetivo").value=Number($("numero-jugadores").value)<=4?5:3;});
    $("btn-generar-partida").addEventListener("click",createRoom); $("btn-pausar")?.addEventListener("click",togglePause);
    $("btn-unirse").addEventListener("click",joinRoom);
    $("codigo-partida").addEventListener("input",e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);});
    $("btn-copiar-codigo").addEventListener("click",async()=>{const code=$("codigo-sala").textContent;await copyText(code,"Código copiado: "+code);});
    $("btn-copiar-enlace")?.addEventListener("click",()=>copyText(roomInviteUrl(),"Enlace de invitación copiado. Compártelo para que solo tengan que escribir su nombre."));
    $("btn-reingreso")?.addEventListener("click",toggleReentry);
    const invitedCode=new URLSearchParams(window.location.search).get('sala');if(invitedCode&&/^[A-HJ-NP-Z2-9]{6}$/i.test(invitedCode)){$('codigo-partida').value=invitedCode.toUpperCase();showScreen('pantalla-unirse');window.setTimeout(()=>$('nombre-jugador')?.focus(),0);}
    $("btn-salir-sala").addEventListener("click",leaveRoom);
    $("btn-salir-juego").addEventListener("click",leaveRoom);
    $("btn-iniciar-partida").addEventListener("click",startGame);
    $("btn-robar").addEventListener("click",drawCard);
    $("btn-pasar").addEventListener("click",endTurn);
  }
  function boot() {
    try {
      if(!window.firebase || !config) throw new Error("No se han cargado los scripts o la configuración de Firebase.");
      if(!firebase.apps.length) firebase.initializeApp(config);
      auth=firebase.auth(); db=firebase.database();
      db.ref('.info/serverTimeOffset').on('value',snap=>{serverOffset=Number(snap.val()||0);});
      auth.onAuthStateChanged(u=>{
        user=u||null;
        if(u){
          setStatus('Firebase conectado','ok');
          cleanupExpiredRooms().catch(e=>console.warn('Limpieza parcial',e));
          try {const remembered=localStorage.getItem('nexus.ultimaSala');
            if(remembered&&!currentCode&&/^[A-HJ-NP-Z2-9]{6}$/.test(remembered))
              db.ref(`salas/${remembered}`).once('value').then(s=>{const d=s.val();if(d?.jugadores?.[u.uid]&&!Core.shouldDelete(d,serverNow()))listen(remembered);else localStorage.removeItem('nexus.ultimaSala');}).catch(()=>{});
          }catch(_){}
        } else setStatus('Iniciando sesión…');
      });
      auth.signInAnonymously().catch(e=>{setStatus("Error de autenticación","bad");fail("No se pudo iniciar sesión anónima",e);});
      wire();
      if(!timerInterval)timerInterval=window.setInterval(()=>{if(room?.juego)updateTimerUI(room.juego);updateRematchClock();},1000);
      // Algunos navegadores o vistas previas bloquean localStorage. No debe
      // impedir que arranque el juego ni que se pueda crear una sala.
      let lastResult=null;
      try{lastResult=localStorage.getItem('nexus.ultimoResultado');}
      catch(e){console.warn('No hay almacenamiento local; los resultados no se conservarán al cerrar el navegador.',e);}
      $('btn-ultimo-resultado')?.classList.toggle('hidden',!lastResult);
      if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('service-worker.js').catch(e=>console.warn('Servicio offline no disponible',e));
      console.log("NEXUS v1.02.1 cargado.");
    } catch(e) {setStatus("Error de configuración","bad");fail("No se pudo iniciar la aplicación",e);}
  }
  document.addEventListener("DOMContentLoaded",boot);
})();

// patch_index.js — wires PayPal, push notifications, Claude AI, nearby guide into v4.0
const fs = require('fs');
const p = '/var/www/bermuda-epass/index.html';
let s = fs.readFileSync(p, 'utf8');

const patches = [

// ── PATCH 1: Real PayPal unlockPremium ──
{
  label: 'PayPal unlockPremium',
  old: `function unlockPremium(){
  // PayPal integration hook
  showToast('💳 Opening payment... (PayPal integration coming)');
  // Simulate for demo:
  setTimeout(function(){
    state.plan='premium'; saveState();
    document.getElementById('paywall').classList.add('hidden');
    document.getElementById('trialExpiredModal').classList.remove('show');
    renderPassBadge();
    showToast('🌟 Premium unlocked! Welcome to full access.');
  }, 1500);
}`,
  new_: `function unlockPremium(){
  showToast('💳 Opening PayPal checkout...');
  fetch('/api/paypal/create-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:'29.99',description:'Bermuda ePass Full Day Pass'})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.ok && d.approveUrl){ window.location.href=d.approveUrl; }
      else { showToast('Payment error. Please try again.'); console.error('PayPal error:',d); }
    })
    .catch(function(e){ showToast('Network error. Try again.'); console.error(e); });
}`
},

// ── PATCH 2: Handle PayPal return URL params + push notification on geo ──
{
  label: 'PayPal return handler + push after trial',
  old: `  // Day/night theme
  applyDayNightTheme();`,
  new_: `  // Handle PayPal return URL params
  (function(){
    var params = new URLSearchParams(window.location.search);
    var trial = params.get('trial');
    var exp = params.get('exp');
    if(trial==='activated' && exp){
      state.plan='premium'; state.trialExpires=null; state.trialStarted=null; saveState();
      document.getElementById('paywall').classList.add('hidden');
      history.replaceState({},document.title,window.location.pathname);
      setTimeout(function(){ renderPassBadge(); showToast('🌟 Premium unlocked! Enjoy Bermuda!'); showAvatar('🎉 Welcome to full access! I am Marcus, your personal island guide.'); }, 600);
    } else if(trial==='failed'){
      history.replaceState({},document.title,window.location.pathname);
      setTimeout(function(){ showToast('⚠️ Payment was not completed. Try again.'); }, 600);
    } else if(trial==='cancelled'){
      history.replaceState({},document.title,window.location.pathname);
      setTimeout(function(){ showToast('Payment cancelled. Your free trial is still active.'); }, 600);
    }
  })();

  // Day/night theme
  applyDayNightTheme();`
},

// ── PATCH 3: Real Claude AI in sendMsg ──
{
  label: 'Real Claude AI sendMsg',
  old: `function sendMsg(){
  var inp = document.getElementById('chatInput');
  if(!inp || !inp.value.trim()) return;
  var text=inp.value.trim(); inp.value='';
  addUserMsg(text);
  addAiMsg(getMarcusReply(text));
}`,
  new_: `function sendMsg(){
  var inp = document.getElementById('chatInput');
  if(!inp || !inp.value.trim()) return;
  var text=inp.value.trim(); inp.value='';
  addUserMsg(text);
  var parish = state.parish ? ' The user is staying in '+state.parish+' parish.' : '';
  var zone = state.geoZone ? ' They arrived via '+state.geoZone+'.' : '';
  fetch('/api/claude',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      model:'claude-haiku-4-5',
      max_tokens:280,
      system:'You are Marcus, a friendly Bermuda tour guide AI. Concise answers under 90 words. Use 1-2 emojis naturally. Focus on Bermuda beaches, food, transport, nightlife, attractions, rum culture, local tips.'+parish+zone,
      messages:[{role:'user',content:text}]
    })
  }).then(function(r){return r.json();})
    .then(function(d){
      var reply=(d.content&&d.content[0]&&d.content[0].text)?d.content[0].text:getMarcusReply(text);
      addAiMsg(reply);
    })
    .catch(function(){ addAiMsg(getMarcusReply(text)); });
}`
},

// ── PATCH 4: Real nearby-guide + push subscription in toggleAvatar ──
{
  label: 'GPS nearby guide in toggleAvatar',
  old: `function toggleAvatar(){
  var bubble=document.getElementById('avatarBubble');
  if(!bubble) return;
  if(bubble.style.display==='none'||!bubble.style.display){
    showAvatar(getMarcusGreeting());
  } else {
    hideAvatarBubble();
  }
}`,
  new_: `function toggleAvatar(){
  var bubble=document.getElementById('avatarBubble');
  if(!bubble) return;
  if(bubble.style.display==='none'||!bubble.style.display){
    if(navigator.geolocation){
      showAvatar('🧙🏾 Finding where you are...');
      navigator.geolocation.getCurrentPosition(
        function(pos){
          fetch('/api/nearby-guide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:pos.coords.latitude,lng:pos.coords.longitude})})
            .then(function(r){return r.json();})
            .then(function(d){ showAvatar(d.ok&&d.guide ? d.guide.slice(0,200) : getMarcusGreeting()); })
            .catch(function(){ showAvatar(getMarcusGreeting()); });
        },
        function(){ showAvatar(getMarcusGreeting()); },
        {timeout:4000,maximumAge:60000}
      );
    } else {
      showAvatar(getMarcusGreeting());
    }
  } else {
    hideAvatarBubble();
  }
}`
},

// ── PATCH 5: Push subscription in startFreeTrial + claimFreeHour ──
{
  label: 'Push subscription after trial start',
  old: `  startTrialCountdown();
}`,
  new_: `  startTrialCountdown();
  setTimeout(subscribeToPush, 2000);
}`
},

// ── PATCH 6: subscribeToPush function (before service worker registration) ──
{
  label: 'subscribeToPush function',
  old: `// Service Worker
if('serviceWorker' in navigator){`,
  new_: `// ── PUSH NOTIFICATIONS ──
function subscribeToPush(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)) return;
  Notification.requestPermission().then(function(p){
    if(p!=='granted'){ showToast('Enable notifications for HOT NOW alerts!'); return; }
    navigator.serviceWorker.ready.then(function(reg){
      fetch('/api/push/vapid-key')
        .then(function(r){return r.json();})
        .then(function(d){
          try {
            var raw=atob(d.publicKey.replace(/-/g,'+').replace(/_/g,'/'));
            var key=new Uint8Array(raw.length);
            for(var i=0;i<raw.length;i++) key[i]=raw.charCodeAt(i);
            reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key})
              .then(function(sub){
                return fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub.toJSON())});
              })
              .then(function(){ showToast('🔔 HOT NOW alerts enabled!'); })
              .catch(function(){});
          } catch(e){}
        }).catch(function(){});
    });
  });
}

// Service Worker
if('serviceWorker' in navigator){`
},

// ── PATCH 7: Wire claimFreeHour to also subscribe to push ──
{
  label: 'Push subscription in claimFreeHour',
  old: `        showToast('Free hour active! Ask the AI Guide anything.');`,
  new_: `        showToast('Free hour active! Ask Marcus anything.');
        setTimeout(subscribeToPush, 2000);`
}

];

let applied = 0;
patches.forEach(function(patch){
  if(s.includes(patch.old)){
    s = s.replace(patch.old, patch.new_);
    console.log('✅ PATCH:', patch.label);
    applied++;
  } else {
    console.log('⚠️  SKIP (not found):', patch.label);
  }
});

fs.writeFileSync(p, s);
console.log('\nDONE: '+applied+'/'+patches.length+' patches applied');

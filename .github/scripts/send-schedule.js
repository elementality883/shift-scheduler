// .github/scripts/send-schedule.js
//
// Morning send (08:00 JST): reads today's pre-generated schedule from JSONBin
// and posts it to WebEx. Does NOT regenerate — uses the schedule the app stored.
//
// Evening send (17:00 JST): reads next work day's pre-generated schedule from
// JSONBin and posts it to WebEx. Does NOT regenerate.
//
// The app generates and stores both schedules in JSONBin under:
//   d.schedToday   = { dk: 'YYYY-MM-DD', slots: [...] }
//   d.schedNextDay = { dk: 'YYYY-MM-DD', slots: [...] }
//
// IMPORTANT: All date calculations use JST (UTC+9). Change TZ_OFFSET_HOURS
// if your team is in a different timezone.

import fetch from 'node-fetch';

const TZ_OFFSET_HOURS = 9;

const WEBEX_TOKEN = process.env.WEBEX_TOKEN;
const WEBEX_ROOM  = process.env.WEBEX_ROOM_ID;
const JB_KEY      = process.env.JSONBIN_KEY;
const JB_BIN      = process.env.JSONBIN_BIN;
const SEND_TYPE   = process.env.SEND_TYPE || 'evening';

if(!WEBEX_TOKEN||!WEBEX_ROOM||!JB_KEY||!JB_BIN){
  console.error('❌ Missing required environment variables:');
  if(!WEBEX_TOKEN) console.error('   WEBEX_TOKEN');
  if(!WEBEX_ROOM)  console.error('   WEBEX_ROOM_ID');
  if(!JB_KEY)      console.error('   JSONBIN_KEY');
  if(!JB_BIN)      console.error('   JSONBIN_BIN');
  process.exit(1);
}

function nowLocal(){
  return new Date(new Date().getTime()+TZ_OFFSET_HOURS*3600*1000);
}
function fmtDate(d){
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
// Returns today if it's a weekday, otherwise the next Monday.
// Saturday → Monday, Sunday → Monday, Mon–Fri → today.
function getThisWorkDay(){
  const d = nowLocal();
  const day = d.getUTCDay();
  if(day === 6) d.setUTCDate(d.getUTCDate()+2); // Saturday → Monday
  if(day === 0) d.setUTCDate(d.getUTCDate()+1); // Sunday  → Monday
  return fmtDate(d);
}
// Returns the next work day after getThisWorkDay — never duplicates.
function getNextWorkDay(){
  const d = new Date(getThisWorkDay()+'T00:00:00Z');
  do{ d.setUTCDate(d.getUTCDate()+1); }while(d.getUTCDay()===0||d.getUTCDay()===6);
  return fmtDate(d);
}
function friendlyDate(dk){
  const [y,m,day]=dk.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,day)).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
}

// Slot definitions — must match index.html exactly
const SLOTS=[
  {time:'09:00 – 10:00',lateOnly:false},
  {time:'10:00 – 11:00',lateOnly:false},
  {time:'11:00 – 12:00',lateOnly:false},
  {time:'12:00 – 13:00',lateOnly:true },
  {time:'13:00 – 14:00',lateOnly:false},
  {time:'14:00 – 15:00',lateOnly:true },
  {time:'16:00 – 17:00',lateOnly:false},
];

// Fallback schedule generator — only used if no stored schedule found in JSONBin
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function getSt(avail,name,dk){return(avail[name]&&avail[name][dk])||'available';}
function buildSchedule(team,avail,dk){
  const late=team.filter(n=>getSt(avail,n,dk)==='late');
  const pool=team.filter(n=>getSt(avail,n,dk)==='available');
  if(pool.length<2) throw new Error(`Not enough available members for ${dk}`);
  const rs=shuffle(pool),ls=shuffle(late);let ri=0,li=0;
  return SLOTS.map(s=>{
    if(s.lateOnly){
      if(!late.length){const p=[],seen=new Set();while(p.length<2){const x=rs[ri%rs.length];ri++;if(!seen.has(x)||rs.length===1){p.push(x);seen.add(x);}}return{...s,assigned:p,hasLate:false,noLate:true};}
      const lp=ls[li%ls.length];li++;let rp=rs[ri%rs.length];ri++;if(rp===lp){rp=rs[ri%rs.length];ri++;}
      return{...s,assigned:[lp,rp],hasLate:true,noLate:false};
    }else{const p=[],seen=new Set();while(p.length<2){const x=rs[ri%rs.length];ri++;if(!seen.has(x)||rs.length===1){p.push(x);seen.add(x);}}return{...s,assigned:p,hasLate:false,noLate:false};}
  });
}

function getPtoLine(team,avail,dk){
  const pto=team.filter(n=>getSt(avail,n,dk)==='pto');
  return pto.length?`🌴 Out on PTO: ${pto.join(', ')}`:`🎉 The Whole Family Is Here!`;
}
function buildMessage(slots,hd,team,avail,dk){
  return `📞 Phone Shift Schedule — ${hd}\n━━━━━━━━━━━━━━━━━━━━━━━\n`+
    slots.map(s=>`  ${s.time}  →  ${s.assigned.join(' · ')}${s.lateOnly&&s.hasLate?'  *(late shift)*':''}`).join('\n')+
    `\n━━━━━━━━━━━━━━━━━━━━━━━\n🕐 Late shift: 12:00–13:00 and 14:00–15:00.\n${getPtoLine(team,avail,dk)}\nHave a great day! 🙌`;
}

async function loadData(){
  console.log('📥 Reading data from JSONBin…');
  const r=await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}/latest`,{headers:{'X-Master-Key':JB_KEY,'X-Bin-Meta':'false'}});
  if(!r.ok) throw new Error(`JSONBin read failed: HTTP ${r.status}`);
  const d=await r.json();
  console.log(`   Team: ${(d.team||[]).join(', ')||'(none)'}`);
  return d;
}

async function sendToWebEx(message){
  console.log('📤 Sending to WebEx…');
  const r=await fetch('https://webexapis.com/v1/messages',{
    method:'POST',
    headers:{'Authorization':`Bearer ${WEBEX_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({roomId:WEBEX_ROOM,text:message})
  });
  if(!r.ok){const b=await r.text().catch(()=>'');throw new Error(`WebEx send failed: HTTP ${r.status} — ${b}`);}
  console.log('   ✅ Sent successfully');
}

async function main(){
  const isEvening = SEND_TYPE==='evening';
  const targetDk  = isEvening ? getNextWorkDay() : getThisWorkDay();
  const hd        = friendlyDate(targetDk);
  const storeKey  = isEvening ? 'schedNextDay' : 'schedToday';

  console.log(`\n🕐 Shift Scheduler — ${isEvening?'Evening (next work day)':'Morning (today)'} Send`);
  console.log(`   UTC time   : ${new Date().toISOString()}`);
  console.log(`   Local time : ${nowLocal().toISOString().slice(0,16).replace('T',' ')} (UTC+${TZ_OFFSET_HOURS})`);
  console.log(`   Target date: ${targetDk} (${hd})`);
  console.log(`   Send type  : ${SEND_TYPE}\n`);

  let data;
  try{data=await loadData();}
  catch(e){console.error('❌ Failed to load data:',e.message);process.exit(1);}

  const{team=[],avail={}}=data;
  if(!team.length){console.warn('⚠ No team members — nothing to schedule');process.exit(0);}

  const stored=data[storeKey];
  let slots;

  if(stored && stored.dk===targetDk && Array.isArray(stored.slots)){
    console.log(`   ✅ Using stored schedule from JSONBin`);
    slots=stored.slots;
  } else {
    console.warn(`   ⚠ No stored schedule for ${targetDk} — generating now (fallback)`);
    try{slots=buildSchedule(team,avail,targetDk);}
    catch(e){console.error('❌ Generation failed:',e.message);process.exit(1);}
  }

  const message=buildMessage(slots,hd,team,avail,targetDk);
  console.log('\n📋 Preview:\n'+('─'.repeat(50))+'\n'+message+'\n'+('─'.repeat(50))+'\n');

  try{await sendToWebEx(message);}
  catch(e){console.error('❌ WebEx send failed:',e.message);process.exit(1);}

  console.log('\n✅ Done');
}

main().catch(e=>{console.error('❌ Unexpected error:',e.message);process.exit(1);});

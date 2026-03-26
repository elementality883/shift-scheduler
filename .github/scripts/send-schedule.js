// .github/scripts/send-schedule.js
//
// Reads team + availability data from JSONBin, generates the schedule
// for today (morning send) or next work day (evening send), and posts
// to a WebEx room.
//
// Run by GitHub Actions — all config comes from environment variables.
// Can also be run locally: set env vars then `node send-schedule.js`

import fetch from 'node-fetch';

// ── Config from environment variables (set as GitHub Secrets) ──────────
const WEBEX_TOKEN  = process.env.WEBEX_TOKEN;
const WEBEX_ROOM   = process.env.WEBEX_ROOM_ID;
const JB_KEY       = process.env.JSONBIN_KEY;
const JB_BIN       = process.env.JSONBIN_BIN;
const SEND_TYPE    = process.env.SEND_TYPE || 'evening'; // 'morning' or 'evening'

// ── Validate ────────────────────────────────────────────────────────────
if(!WEBEX_TOKEN || !WEBEX_ROOM || !JB_KEY || !JB_BIN){
  console.error('❌ Missing required environment variables:');
  if(!WEBEX_TOKEN)  console.error('   WEBEX_TOKEN');
  if(!WEBEX_ROOM)   console.error('   WEBEX_ROOM_ID');
  if(!JB_KEY)       console.error('   JSONBIN_KEY');
  if(!JB_BIN)       console.error('   JSONBIN_BIN');
  process.exit(1);
}

// ── Slot definitions (must match index.html exactly) ────────────────────
const SLOTS = [
  { time:'09:00 – 10:00', lateOnly:false },
  { time:'10:00 – 11:00', lateOnly:false },
  { time:'11:00 – 12:00', lateOnly:false },
  { time:'12:00 – 13:00', lateOnly:true  },
  { time:'13:00 – 14:00', lateOnly:false },
  { time:'14:00 – 15:00', lateOnly:true  },
  { time:'16:00 – 17:00', lateOnly:false },
];

// ── Date helpers ────────────────────────────────────────────────────────
function fmtDate(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getToday(){ return fmtDate(new Date()); }

function getNextWorkDay(){
  const d = new Date();
  do { d.setDate(d.getDate()+1); } while(d.getDay()===0 || d.getDay()===6);
  return fmtDate(d);
}

function friendlyDate(dk){
  const obj = new Date(dk+'T00:00:00');
  return obj.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}

// ── Schedule logic (mirrors index.html buildSched exactly) ──────────────
function shuffle(arr){
  const a = [...arr];
  for(let i=a.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function getStatus(avail, name, dk){
  return (avail[name] && avail[name][dk]) || 'available';
}

function buildSchedule(team, avail, dk){
  const lateMembers = team.filter(n => getStatus(avail,n,dk) === 'late');
  const randomPool  = team.filter(n => getStatus(avail,n,dk) === 'available');

  if(randomPool.length < 2){
    throw new Error(`Not enough available members for ${dk} — need at least 2 set to Available`);
  }

  const randShuf = shuffle(randomPool);
  const lateShuf = shuffle(lateMembers);
  let ri=0, li=0;

  return SLOTS.map(s => {
    if(s.lateOnly){
      if(lateMembers.length === 0){
        // No late person — fill with 2 random, flag warning
        const p = [];
        const seen = new Set();
        while(p.length < 2){
          const person = randShuf[ri % randShuf.length]; ri++;
          if(!seen.has(person) || randShuf.length===1){ p.push(person); seen.add(person); }
        }
        return { ...s, assigned:p, hasLate:false, noLate:true };
      }
      // Late shift person + 1 random
      const latePerson = lateShuf[li % lateShuf.length]; li++;
      let randPerson   = randShuf[ri % randShuf.length]; ri++;
      if(randPerson === latePerson){ randPerson = randShuf[ri % randShuf.length]; ri++; }
      return { ...s, assigned:[latePerson, randPerson], hasLate:true, noLate:false };
    } else {
      const p = [];
      const seen = new Set();
      while(p.length < 2){
        const person = randShuf[ri % randShuf.length]; ri++;
        if(!seen.has(person) || randShuf.length===1){ p.push(person); seen.add(person); }
      }
      return { ...s, assigned:p, hasLate:false, noLate:false };
    }
  });
}

// ── Message builder (mirrors index.html buildMsg exactly) ───────────────
function getPtoLine(team, avail, dk){
  const ptoNames = team.filter(n => getStatus(avail,n,dk) === 'pto');
  return ptoNames.length > 0
    ? `🌴 Out on PTO: ${ptoNames.join(', ')}`
    : `🎉 The Whole Family Is Here!`;
}

function buildMessage(result, hd, team, avail, dk){
  const lines = result.map(s =>
    `  ${s.time}  →  ${s.assigned.join(' · ')}${s.lateOnly&&s.hasLate ? '  *(late shift)*' : ''}`
  );
  return (
    `📞 Phone Shift Schedule — ${hd}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 Late shift: 12:00–13:00 and 14:00–15:00.\n` +
    `${getPtoLine(team, avail, dk)}\n` +
    `Have a great day! 🙌`
  );
}

// ── JSONBin read ─────────────────────────────────────────────────────────
async function loadData(){
  console.log('📥 Reading data from JSONBin…');
  const r = await fetch(`https://api.jsonbin.io/v3/b/${JB_BIN}/latest`, {
    headers: { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  });
  if(!r.ok) throw new Error(`JSONBin read failed: HTTP ${r.status}`);
  const d = await r.json();
  console.log(`   Team members: ${(d.team||[]).join(', ') || '(none)'}`);
  return d;
}

// ── WebEx send ───────────────────────────────────────────────────────────
async function sendToWebEx(message){
  console.log('📤 Sending to WebEx…');
  const r = await fetch('https://webexapis.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WEBEX_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ roomId: WEBEX_ROOM, text: message })
  });
  if(!r.ok){
    const body = await r.text().catch(()=>'');
    throw new Error(`WebEx send failed: HTTP ${r.status} — ${body}`);
  }
  console.log('   ✅ Message sent successfully');
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(){
  const isEvening = SEND_TYPE === 'evening';
  const dk        = isEvening ? getNextWorkDay() : getToday();
  const hd        = friendlyDate(dk);
  const sendLabel = isEvening ? 'Evening (next work day)' : 'Morning (today)';

  console.log(`\n🕐 Shift Scheduler — ${sendLabel} Send`);
  console.log(`   Target date : ${hd}`);
  console.log(`   Send type   : ${SEND_TYPE}\n`);

  let data;
  try{
    data = await loadData();
  }catch(e){
    console.error('❌ Failed to load data:', e.message);
    process.exit(1);
  }

  const { team=[], avail={} } = data;
  if(team.length === 0){
    console.warn('⚠ No team members found — nothing to schedule');
    process.exit(0);
  }

  let result;
  try{
    result = buildSchedule(team, avail, dk);
  }catch(e){
    console.error('❌ Schedule generation failed:', e.message);
    process.exit(1);
  }

  const message = buildMessage(result, hd, team, avail, dk);

  console.log('\n📋 Schedule preview:');
  console.log('─'.repeat(50));
  console.log(message);
  console.log('─'.repeat(50)+'\n');

  try{
    await sendToWebEx(message);
  }catch(e){
    console.error('❌ WebEx send failed:', e.message);
    process.exit(1);
  }

  console.log('\n✅ Done');
}

main().catch(e => {
  console.error('❌ Unexpected error:', e.message);
  process.exit(1);
});

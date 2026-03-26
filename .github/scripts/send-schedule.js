// .github/scripts/send-schedule.js
//
// Reads team + availability data from JSONBin, generates the schedule
// for today (morning send) or next work day (evening send), and posts
// to a WebEx room.
//
// IMPORTANT: All date calculations use JST (UTC+9) regardless of where
// GitHub Actions runs. Change TZ_OFFSET_HOURS if your team is elsewhere.

import fetch from 'node-fetch';

// ── Timezone config ─────────────────────────────────────────────────────
const TZ_OFFSET_HOURS = 9; // JST = UTC+9. Change this for your timezone.
//   UK GMT  = 0    UK BST  = 1
//   US EST  = -5   US PST  = -8

// ── Config from environment variables (set as GitHub Secrets) ───────────
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

// ── Date helpers (all in local timezone, not UTC) ────────────────────────

// Returns a Date object representing "now" in the configured timezone.
// GitHub Actions runs in UTC — this shifts the date to the correct local day.
function nowLocal(){
  const utc = new Date();
  return new Date(utc.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
}

function fmtDate(d){
  // d is already shifted to local time — use UTC getters to read the shifted values
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function getUTCDay(d){ return d.getUTCDay(); } // 0=Sun, 6=Sat on the shifted date

function getToday(){
  return fmtDate(nowLocal());
}

function getNextWorkDay(){
  const d = nowLocal();
  do {
    d.setUTCDate(d.getUTCDate()+1);
  } while(getUTCDay(d)===0 || getUTCDay(d)===6);
  return fmtDate(d);
}

function friendlyDate(dk){
  // Parse YYYY-MM-DD as a local date (not UTC) for display
  const [y,m,day] = dk.split('-').map(Number);
  const obj = new Date(y, m-1, day);
  return obj.toLocaleDateString('en-GB',{
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });
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

// ── Schedule logic (mirrors index.html buildSched exactly) ───────────────
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
    throw new Error(
      `Not enough available members for ${dk} — need at least 2 set to Available`
    );
  }

  const randShuf = shuffle(randomPool);
  const lateShuf = shuffle(lateMembers);
  let ri=0, li=0;

  return SLOTS.map(s => {
    if(s.lateOnly){
      if(lateMembers.length === 0){
        const p = [];
        const seen = new Set();
        while(p.length < 2){
          const person = randShuf[ri % randShuf.length]; ri++;
          if(!seen.has(person) || randShuf.length===1){ p.push(person); seen.add(person); }
        }
        return { ...s, assigned:p, hasLate:false, noLate:true };
      }
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

// ── Message builder (mirrors index.html buildMsg exactly) ────────────────
function getPtoLine(team, avail, dk){
  const ptoNames = team.filter(n => getStatus(avail,n,dk) === 'pto');
  return ptoNames.length > 0
    ? `🌴 Out on PTO: ${ptoNames.join(', ')}`
    : `🎉 The Whole Family Is Here!`;
}

function buildMessage(result, hd, team, avail, dk, isUpdate){
  const lines = result.map(s =>
    `  ${s.time}  →  ${s.assigned.join(' · ')}` +
    `${s.lateOnly && s.hasLate ? '  *(late shift)*' : ''}`
  );
  const prefix = isUpdate ? '🔄 UPDATED — ' : '';
  const update = isUpdate
    ? '\n⚠ This schedule was updated due to an availability change.'
    : '';
  return (
    `${prefix}📞 Phone Shift Schedule — ${hd}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 Late shift: 12:00–13:00 and 14:00–15:00.\n` +
    `${getPtoLine(team, avail, dk)}` +
    `${update}\n` +
    `Have a great day! 🙌`
  );
}

// ── JSONBin read ──────────────────────────────────────────────────────────
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

// ── WebEx send ────────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────
async function main(){
  const isEvening = SEND_TYPE === 'evening';
  const dk        = isEvening ? getNextWorkDay() : getToday();
  const hd        = friendlyDate(dk);
  const sendLabel = isEvening ? 'Evening (next work day)' : 'Morning (today)';

  // Log times so it's easy to verify correct date in the Actions run log
  const utcNow   = new Date();
  const localNow = nowLocal();
  console.log(`\n🕐 Shift Scheduler — ${sendLabel} Send`);
  console.log(`   UTC time    : ${utcNow.toISOString()}`);
  console.log(`   Local time  : ${localNow.toISOString().replace('T',' ').slice(0,16)} (UTC${TZ_OFFSET_HOURS>=0?'+':''}${TZ_OFFSET_HOURS})`);
  console.log(`   Target date : ${dk} (${hd})`);
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

  const message = buildMessage(result, hd, team, avail, dk, false);

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

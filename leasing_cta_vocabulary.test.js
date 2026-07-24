// CLOSED CTA VOCABULARY (ruled): navigation → Open · send_application → Send ·
// complete_task → Complete · unknown → disabled Unavailable. The row sentence
// stays specific; the button says only what pressing it does. No free-text CTA.
const fs=require('fs');
const path=require('path');
const dir=process.argv[2]||'.';
const desk=fs.readFileSync(path.join(dir,'leasing_desk.js'),'utf8');
const door=fs.readFileSync(path.join(dir,'followups-door.js'),'utf8');
let pass=0,fail=0;
const ok=(n,c)=>{ c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n)); };

// API side — the vocabulary is closed at the source
const labels=[...desk.matchAll(/label:\s*"([^"]+)"/g)].map(m=>m[1]);
ok('exactly three CTA labels exist', new Set(labels).size===3);
ok('the three are Open, Send, Complete', ['Open','Send','Complete'].every(v=>labels.includes(v)));
ok('no free-text label pass-through as CTA', !/label:\s*valueOrNull\(row\.next_move_label\)/.test(desk));
ok('retired countersign CTA is gone', !/Review and countersign/.test(desk));
ok('navigation actions all say Open', !/label:\s*"Review[^"]*"/.test(desk));
ok('row sentences remain specific (state_label untouched)', /state_label:\s*valueOrNull\(/.test(desk));

// Behavioral: the normalizer itself, executed
const sandbox={module:{exports:{}},exports:{},require:()=>({})};
try{
  const fn=new Function('module','exports','require',desk+'\nreturn {normalizeApplicationAction};');
  const {normalizeApplicationAction}=fn(sandbox.module,sandbox.exports,sandbox.require);
  const open1=normalizeApplicationAction({application_id:'a1'},{state:'available',code:'confirm_proposed_terms'});
  ok('terms-review action renders as Open', open1.label==='Open' && open1.kind==='navigation');
  const blocked=normalizeApplicationAction({application_id:'a1'},{state:'blocked',code:'anything'});
  ok('blocked action is still Open (navigate to the blocker)', blocked.label==='Open');
}catch(e){ ok('normalizer executes standalone ('+e.message+')', false); }

// App side — closed dispatch and honest unknowns
ok('validation marks unsupported at LOAD time', /row\.action_unsupported\s*=\s*true/.test(door));
ok('unsupported renders disabled Unavailable', /disabled title="This action is not supported in the operator app yet\."\s*>Unavailable</.test(door));
ok('the reason is written next to the button', /This action is not supported in the operator app yet\.<\/div>/.test(door));
ok('dispatcher fall-through is a stop, not a UX path', /unreachable when validation ran/.test(door));
ok('no click handler on an unsupported row', /action_unsupported\s*\n?\s*\?\s*'<button class="pslh-btn" disabled/.test(door) || /row\.action_unsupported\s*?[\s\S]{0,80}disabled/.test(door));
console.log(`${pass}/${pass+fail}`);
process.exit(fail?1:0);

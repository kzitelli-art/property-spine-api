// ONE RELATIONSHIP, ONE ROW. An application follow-up and the application it
// belongs to must never render as two rows. Keys prefer application_id (the
// downstream shared identifier); stage rank picks the survivor.
const path=require('path');
const desk=require(path.resolve(process.argv[2]||'.','leasing_desk.js'));
let pass=0,fail=0;
const ok=(n,c)=>{ c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n)); };

const followup={desk_key:'obligation:ob1',stage:'application',conversion_id:'c1',application_id:'a1',due_state:'overdue',source:'followup_rail'};
const appRow  ={desk_key:'application:a1',stage:'lease_sent',conversion_id:null,application_id:'a1',due_state:'none',source:'application_lifecycle'};

let out=desk.dedupeLifecycleRows([followup,appRow]);
ok('same relationship collapses to one row', out.length===1);
ok('downstream stage wins', out[0]&&out[0].stage==='lease_sent');
ok('the merge is counted, not hidden', out[0]&&out[0].related_open_count===2);

out=desk.dedupeLifecycleRows([followup]);
ok('a follow-up alone still renders', out.length===1);

const otherApp={...appRow,desk_key:'application:a2',application_id:'a2'};
out=desk.dedupeLifecycleRows([followup,otherApp]);
ok('different relationships never merge', out.length===2);

const bare={desk_key:'obligation:ob9',stage:'post_tour',conversion_id:null,application_id:null,due_state:'due_soon',source:'followup_rail'};
out=desk.dedupeLifecycleRows([bare,followup,appRow]);
ok('a pre-application obligation keeps its own row', out.length===2);

// one conversion, TWO applications (re-application): one deal, one row, downstream wins
const firstApp ={desk_key:'application:x1',stage:'application',conversion_id:'cm',application_id:'x1',due_state:'none',source:'application_lifecycle'};
const secondApp={desk_key:'application:x2',stage:'lease_sent', conversion_id:'cm',application_id:'x2',due_state:'none',source:'application_lifecycle'};
out=desk.dedupeLifecycleRows([firstApp,secondApp]);
ok('two applications on one conversion collapse to the deal', out.length===1);
ok('the downstream application is the survivor', out[0]&&out[0].application_id==='x2');
console.log(`${pass}/${pass+fail}`);
process.exit(fail?1:0);

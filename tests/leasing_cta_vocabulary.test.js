// CLOSED CTA CONTRACT: three verbs plus one honest disabled fallback.
const assert=require('assert');
const path=require('path');
const desk=require(path.resolve(process.argv[2]||'.','leasing_desk.js'));
let pass=0; const ok=(value,message)=>{assert.ok(value,message);pass++;};
let action=desk.normalizeStageApplicationAction({application_id:'a1'},{state:'available',code:'confirm_proposed_terms'});
ok(action.label==='Open'&&action.kind==='navigation','application navigation is Open');
action=desk.normalizeFollowupAction({obligation_id:'o1',conversion_id:'c1',next_move_code:'send_application'});
ok(action.label==='Send'&&action.code==='send_application','application dispatch is Send');
action=desk.normalizeFollowupAction({obligation_id:'o2',person_id:'p2',next_move_code:'send_follow_up'});
ok(action.label==='Open'&&action.target.type==='person','communication is Open');
action=desk.normalizeFollowupAction({obligation_id:'o3',next_move_code:null});
ok(action.label==='Complete'&&action.code==='complete_task','generic closure is Complete');
action=desk.normalizeFollowupAction({obligation_id:'o4',next_move_code:'unknown_move'});
ok(action.label==='Unavailable'&&action.kind==='unsupported'&&action.reason,'unknown action is unavailable');
action=desk.normalizeFollowupAction({obligation_id:'o5',next_move_code:'send_follow_up'});
ok(action.kind==='unsupported'&&/durable person/i.test(action.reason),'communication without person is unavailable');
console.log(`leasing CTA vocabulary: ${pass}/${pass}`);

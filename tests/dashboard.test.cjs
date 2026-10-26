const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.events={}; this.className=''; this.textContent=''; this.attrs={}; this.classList={toggle:(name,value)=>{const list=new Set(this.className.split(' ').filter(Boolean));value?list.add(name):list.delete(name);this.className=[...list].join(' ');}}; }
  append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.events[k]=fn;}click(){this.events.click?.();}
}
function setup() {
  const nodes=Object.fromEntries(['connectButton','connectionStatus','availableCount','totalCount','dataStatus','parkingSlots'].map(id=>[id,new Element()]));
  const lot=new Element(), clients=[], timers=new Map(); let timerId=0, tick, now=Date.now();
  class FakeDate extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
  class Client {
    constructor(){clients.push(this);}connect(opts){this.options=opts;}subscribe(topic,opts){this.topic=topic;opts.onSuccess();}disconnect(){this.onConnectionLost?.();}
    receive(payload,retained=false,topic=this.topic){this.onMessageArrived({payloadString:payload,destinationName:topic,retained});}
  }
  const ctx={console,Date:FakeDate,document:{getElementById:id=>nodes[id],querySelector:()=>lot,createElement:t=>new Element(t)},Paho:{MQTT:{Client}},location:{protocol:'file:'},setInterval:fn=>{tick=fn;},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),addEventListener(){}};
  ctx.window=ctx; vm.createContext(ctx);
  for(const file of ['config.js','mqtt-array.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
  const connect=()=>{nodes.connectButton.click();const client=clients.at(-1);client.options.onSuccess();return client;};
  return {nodes,lot,clients,timers,connect,advance:ms=>{now+=ms;tick();}};
}
test('starts with three unknown bays and no fabricated availability',()=>{
  const {nodes}=setup();assert.equal(nodes.parkingSlots.children.length,3);assert.equal(nodes.availableCount.textContent,'—');
});
test('MQTT snapshots resize a single row and update vacancies atomically',()=>{
  const {nodes,connect}=setup();const client=connect();assert.equal(client.topic,'parkerwatcher/lot01/slots');
  client.receive('[1,0,null]');assert.equal(nodes.parkingSlots.children.length,3);assert.equal(nodes.availableCount.textContent,1);assert.equal(nodes.totalCount.textContent,3);assert.equal(nodes.parkingSlots.children[2].attrs['aria-label'],'A3 รอข้อมูล');
  client.receive('[1,0,1,0]');assert.equal(nodes.parkingSlots.children.length,4);assert.equal(nodes.availableCount.textContent,2);assert.equal(nodes.totalCount.textContent,4);
  client.receive('[1,0,1,0,1,1]');assert.equal(nodes.parkingSlots.children.length,6);assert.equal(nodes.availableCount.textContent,2);assert.equal(nodes.totalCount.textContent,6);
  assert.match(nodes.parkingSlots.children[0].attrs['aria-label'],/A1 มีรถ/);assert.match(nodes.parkingSlots.children[1].attrs['aria-label'],/A2 ว่าง/);
  client.receive('[0,null]');assert.equal(nodes.parkingSlots.children.length,2);assert.equal(nodes.availableCount.textContent,1);
});
test('invalid payload and messages from another topic preserve the last valid snapshot',()=>{
  const {nodes,connect}=setup(),client=connect();client.receive('[1,0]');client.receive('[0,3,0]');assert.equal(nodes.parkingSlots.children.length,2);assert.equal(nodes.availableCount.textContent,1);assert.match(nodes.connectionStatus.textContent,/ข้อความไม่ถูกต้อง/);
  client.receive('[0,0,0]',false,'other/slots');assert.equal(nodes.parkingSlots.children.length,2);
});
test('retained arrays and expired observations do not claim confirmed vacancies',()=>{
  const {nodes,connect,advance}=setup(),client=connect();client.receive('[0,0]',true);assert.equal(nodes.availableCount.textContent,'—');client.receive('[0,0]');assert.equal(nodes.availableCount.textContent,2);advance(181000);assert.equal(nodes.availableCount.textContent,'—');assert.match(nodes.dataStatus.textContent,/ข้อมูลเก่า/);
});
test('disconnect cancels retry and ignores messages from obsolete connections',()=>{
  const {nodes,connect,timers}=setup(),client=connect();client.receive('[0,1]');client.onConnectionLost();assert.equal(timers.size,1);nodes.connectButton.click();assert.equal(timers.size,0);assert.equal(nodes.availableCount.textContent,'—');client.receive('[0,0,0]');assert.equal(nodes.parkingSlots.children.length,2);
});

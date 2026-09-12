// Round-trip + parse verification against the protocol extracted from PeakDo's PWA.
function parseBLEFloat16(raw){const m=raw&0x0FFF,e=raw>>12;const mm=(m&0x0800)?m-0x1000:m;const ee=(e&0x08)?e-0x10:e;return mm*Math.pow(10,ee);}
function floatToBleFloat16(value){
  if(Number.isNaN(value))return 0x07FF;
  let bm=0,be=0,me=Infinity;
  for(let exp=-8;exp<=7;exp++){const sc=value/Math.pow(10,exp);if(sc>2047||sc<-2048)continue;
    const mn=Math.round(sc),ap=mn*Math.pow(10,exp),er=Math.abs(ap-value);
    if(er<me){me=er;bm=mn;be=exp;}}
  return ((be&0x0F)<<12)|(bm&0x0FFF);
}
const cases=[0,1.2,-1.2,12.9,13.0,123.4,1234.5,20.1,3.1,62.3,34.6,-2.5,240];
let ok=true;
for(const c of cases){const enc=floatToBleFloat16(c);const dec=parseBLEFloat16(enc);
  const err=Math.abs(dec-c);const rel=c?err/Math.abs(c):0;
  const pass=rel<0.005;if(!pass)ok=false;
  console.log(`${pass?'PASS':'FAIL'}  ${String(c).padStart(8)} -> 0x${enc.toString(16).padStart(4,'0')} -> ${dec}  (rel err ${(rel*100).toFixed(3)}%)`);}

// Build a synthetic EXT_BATTERY_INFO frame and decode it with the app's layout.
function buildBat({level,volt,amp,power,remain,cap,maxCap,status,full}){
  const b=new Uint8Array(16);const dv=new DataView(b.buffer);
  dv.setInt8(0,1); dv.setInt8(1,status); dv.setUint8(2,full?1:0);
  dv.setUint16(3,floatToBleFloat16(maxCap),true);
  dv.setUint16(5,floatToBleFloat16(cap),true);
  dv.setUint8(7,level);
  dv.setUint16(8,floatToBleFloat16(volt),true);
  dv.setUint16(10,floatToBleFloat16(amp),true);
  dv.setUint16(12,floatToBleFloat16(power),true);
  dv.setUint16(14,remain,true);
  return dv;
}
function parseBat(dv){return{
  enabled:dv.getInt8(0), status:dv.getInt8(1)===-1?2:dv.getInt8(1), isFull:dv.getUint8(2)===1,
  maxCapacity:parseBLEFloat16(dv.getUint16(3,true)), capacity:parseBLEFloat16(dv.getUint16(5,true)),
  level:dv.getUint8(7), voltage:parseBLEFloat16(dv.getUint16(8,true)),
  current:parseBLEFloat16(dv.getUint16(10,true)), power:parseBLEFloat16(dv.getUint16(12,true)),
  remain:dv.getUint16(14,true)};}

const dv=buildBat({level:78,volt:12.86,amp:-2.41,power:-30.99,remain:214,cap:77,maxCap:99,status:-1,full:false});
const parsed=parseBat(dv);
console.log('\nEXT_BATTERY_INFO decode:',JSON.stringify(parsed,null,1));
const expect={level:78,remain:214,status:2,isFull:false};
for(const k of Object.keys(expect)){
  const pass=parsed[k]===expect[k]; if(!pass)ok=false;
  console.log(`${pass?'PASS':'FAIL'}  ${k} = ${parsed[k]} (expected ${expect[k]})`);
}
console.log('\nOVERALL:', ok?'ALL CHECKS PASS':'FAILURES PRESENT');
process.exit(ok?0:1);

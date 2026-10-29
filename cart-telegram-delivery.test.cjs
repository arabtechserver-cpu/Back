const {test,after}=require('node:test');
const assert=require('node:assert/strict');
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/unused';
process.env.JWT_SECRET='cart-telegram-isolated-test-secret-123456';
process.env.TELEGRAM_BOT_TOKEN='synthetic-token';
process.env.TELEGRAM_ADMIN_CHAT_ID='';
const {prisma}=require('./dist/utils/prisma');
const axios=require('axios');
const {sendCartOrderNotifications}=require('./dist/utils/cart-order-notifications');
const {sendTelegramPhotoNotification}=require('./dist/utils/telegramService');
after(()=>prisma.$disconnect());

test('every purchased cart package sends escaped customer and target details to persisted admins',async()=>{
 const originalSetting=prisma.setting.findUnique,originalPost=axios.post;
 const messages=[];
 try{
  prisma.setting.findUnique=async()=>({value:'["admin-one","admin-two","admin-one"]'});
  axios.post=async(url,body,config)=>{assert.ok(url.endsWith('/sendMessage'));assert.equal(config.timeout,10000);messages.push(body);return{data:{ok:true}};};
  const first={id:'order-000001',serviceName:'100 💎 <package>',targetInput:'222855265',quantity:1,price:1,notes:JSON.stringify({groupName:'Free Fire',customFields:{player_id:'222855265',name:'<b>injected</b>'},userNote:'A & B'})};
  await sendCartOrderNotifications([first,{...first,id:'order-000002',targetInput:'987654321',quantity:2,price:2}],{fullName:'Client <name>',username:'client',email:'client@example.invalid',balance:1});
  assert.equal(messages.length,4);assert.deepEqual(messages.map(m=>m.chat_id),['admin-one','admin-two','admin-one','admin-two']);
  assert.match(messages[0].text,/222855265/);assert.match(messages[0].text,/Free Fire/);assert.match(messages[0].text,/\$1\.00 USD/);
  assert.match(messages[0].text,/&lt;b&gt;injected&lt;\/b&gt;/);assert.match(messages[0].text,/Client &lt;name&gt;/);assert.match(messages[0].text,/A &amp; B/);
  assert.match(messages[2].text,/000002/);assert.match(messages[2].text,/987654321/);assert.match(messages[2].text,/\$2\.00 USD/);
  messages.length=0;
  axios.post=async()=>{throw {response:{data:{description:'synthetic bot failure'}}};};
  assert.equal(await sendTelegramPhotoNotification({caption:'synthetic order'}),false,'A rejected send must not report successful delivery');
  prisma.setting.findUnique=async()=>({value:'[]'});
  axios.post=async()=>{throw Error('No network call is allowed without recipients');};
  assert.equal(await sendTelegramPhotoNotification({caption:'synthetic order'}),false);
 }finally{prisma.setting.findUnique=originalSetting;axios.post=originalPost;}
});

// Opt-in: node --env-file=.env --test cart-postgres-integration.test.cjs
// Only localhost PostgreSQL is accepted; every row lives in a disposable schema.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {PrismaClient}=require('@prisma/client');

test('real Prisma/PostgreSQL cart repairs missing storage and purchases two manual packages atomically', {skip:process.env.ALLOW_LOCAL_CART_DB_TEST!=='1'},async()=>{
 const baseUrl=new URL(process.env.DATABASE_URL);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(baseUrl.hostname),'This test never connects to a remote database');
 const schema='borai_cart_test_'+Date.now(); assert.match(schema,/^borai_cart_test_\d+$/);
 baseUrl.searchParams.set('schema',schema);
 const db=new PrismaClient({datasources:{db:{url:baseUrl.toString()}}});
 process.env.JWT_SECRET='cart-isolated-postgres-integration-secret-123456';
 const {prisma}=require('./dist/utils/prisma');
 const {ensureCartSchema}=require('./dist/utils/cart-schema');
 const originals={};
 try{
  // Prisma initializes the isolated schema; no existing schema is modified.
  execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'db','push','--skip-generate'],{cwd:__dirname,env:{...process.env,DATABASE_URL:baseUrl.toString()},stdio:'pipe'});
  const user=await db.user.create({data:{fullName:'Cart integration',email:'cart-integration@example.invalid',username:'cart-integration',password:'not-a-login-password',balance:20}});
  const service=await db.dhruService.create({data:{dhruId:'pkg_cart_test',name:'100 💎',originalName:'100 💎',groupName:'Free Fire',credit:0,margin:1,time:'manual',providerId:null}});
  await db.$executeRawUnsafe('DROP TABLE "CartItem"');
  await assert.rejects(db.cartItem.findMany(),error=>error.code==='P2021');
  await ensureCartSchema(db);
  for(const key of ['cartItem','user','dhruService','order','transaction']){
   for(const method of ['findMany','findFirst','findUnique','create','update','updateMany','delete','deleteMany','count']){
    if(typeof prisma[key][method]==='function'){
     originals[key+'.'+method]=prisma[key][method];prisma[key][method]=db[key][method].bind(db[key]);
    }
   }
  }
  originals.$transaction=prisma.$transaction;prisma.$transaction=db.$transaction.bind(db);
  const router=require('./dist/routes/cart').default;
  const call=async(method,route,body={})=>{
   const handler=router.stack.find(l=>l.route?.path===route&&l.route.methods[method]).route.stack.at(-1).handle;
   const response={statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
   await handler({user,body,params:{}},response);return response;
  };
  assert.equal((await call('get','/')).body.items.length,0);
  for(const [target,quantity] of [['123456789',1],['987654321',2]]){
   const added=await call('post','/',{serviceId:service.id,serviceName:'client name',price:0.01,targetInput:target,customFields:{player_id:target},quantity});
   assert.equal(added.statusCode,200);assert.equal(added.body.item.price,1);
  }
  const cart=await call('get','/');assert.equal(cart.body.count,3);assert.equal(cart.body.total,3);
  const checked=await call('post','/checkout');assert.equal(checked.statusCode,200);assert.equal(checked.body.success,true);
  assert.equal((await db.user.findUnique({where:{id:user.id}})).balance,17);
  assert.equal(await db.cartItem.count(),0);assert.equal(await db.order.count(),2);assert.equal(await db.transaction.count(),1);
  const orders=await db.order.findMany({orderBy:{targetInput:'asc'}});
  assert.deepEqual(orders.map(o=>[o.targetInput,o.quantity,o.price,o.status]),[['123456789',1,1,'pending'],['987654321',2,2,'pending']]);
  assert.equal(JSON.parse(orders[0].notes).customFields.player_id,'123456789');
 }finally{
  for(const [key,original]of Object.entries(originals)){if(key==='$transaction')prisma.$transaction=original;else{const [model,method]=key.split('.');prisma[model][method]=original;}}
  await db.$executeRawUnsafe('DROP SCHEMA "'+schema+'" CASCADE');
  await db.$disconnect();await prisma.$disconnect();
 }
});

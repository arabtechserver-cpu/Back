const { test, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'manual-cart-isolated-test-secret-12345678';
const { prisma } = require('./dist/utils/prisma');
const { quoteCartItem, default: router } = require('./dist/routes/cart');
after(() => prisma.$disconnect());
const user = { id:'test-user', status:'active', balance:20, customDiscount:0, membershipTier:null };
const manual = { id:'manual-service', name:'100 💎', groupName:'Free Fire', providerId:null, isActive:true, credit:0, margin:1, supportsQty:false, minQty:1, maxQty:0 };
test('manual packages allow multiple units and use stored price instead of client values', () => {
 assert.equal(quoteCartItem({ quantity:2, price:0.01 },manual,user).total,2);
 assert.equal(quoteCartItem({ quantity:1 },manual,user).total,1);
 assert.equal(quoteCartItem({ quantity:2 },manual,{...user, customDiscount:10}).total,1.8);
 for (const quantity of [0,-1,1.5,NaN,Infinity,1_000_001]) assert.throws(()=>quoteCartItem({quantity},manual,user),/INVALID_QUANTITY/);
 assert.throws(()=>quoteCartItem({quantity:1},{...manual,margin:0},user),/PRICE_UNAVAILABLE/);
 assert.throws(()=>quoteCartItem({quantity:1},{...manual,isActive:false},user),/SERVICE_UNAVAILABLE/);
 assert.throws(()=>quoteCartItem({quantity:1},manual,{...user,status:'suspended'}),/SERVICE_UNAVAILABLE/);
});
test('provider quantity limits remain enforced for provider-linked services', () => {
 assert.throws(()=>quoteCartItem({quantity:2},{...manual,providerId:'provider',name:'Fixed package'},user),/INVALID_QUANTITY/);
 const provider = {...manual,providerId:'provider',name:'Quantity service',supportsQty:true,minQty:5,maxQty:10};
 assert.equal(quoteCartItem({quantity:5},provider,user).total,5);
 assert.throws(()=>quoteCartItem({quantity:11},provider,user),/INVALID_QUANTITY/);
});
const handler = route => router.stack.find(layer => layer.route?.path === route && layer.route.methods.post).route.stack.at(-1).handle;
const response = () => ({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
test('cart checkout creates pending manual orders, deducts once, stores target data and clears only purchased items', async () => {
 const originalTransaction = prisma.$transaction, originalUser = prisma.user.findUnique;
 const items = [
  {id:'cart-1',serviceId:manual.id,quantity:1,price:0.01,targetInput:'8960415213',customFields:'{"player_id":"8960415213"}'},
  {id:'cart-2',serviceId:manual.id,quantity:2,price:0.01,targetInput:'8969414214',customFields:'{"player_id":"8969414214"}'},
 ];
 const orders=[], transactions=[]; let balance=user.balance, removed;
 const tx = {
  cartItem:{findMany:async()=>items, deleteMany:async(args)=>{removed=args.where.id.in;}},
  dhruService:{findMany:async()=>[manual]},
  user:{findUnique:async()=>({...user,balance}),updateMany:async({where,data})=>{if(balance<where.balance.gte)return{count:0};balance-=data.balance.decrement;return{count:1};}},
  order:{create:async({data})=>{const order={...data,id:'order-'+orders.length};orders.push(order);return order;}},
  transaction:{create:async({data})=>{transactions.push(data);}},
 };
 try {
  prisma.$transaction = async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');return fn(tx);};
  prisma.user.findUnique = async()=>({balance});
  const res=response(); await handler('/checkout')({user:{id:user.id},body:{}},res);
  assert.equal(res.statusCode,200); assert.equal(res.body.success,true); assert.equal(balance,17);
  assert.deepEqual(orders.map(o=>[o.quantity,o.price,o.status,o.targetInput]),[[1,1,'pending','8960415213'],[2,2,'pending','8969414214']]);
  assert.equal(JSON.parse(orders[0].notes).customFields.player_id,'8960415213');
  assert.equal(transactions.length,1); assert.equal(transactions[0].amount,3);
  assert.deepEqual(removed,['cart-1','cart-2']); assert.equal(res.body.orderIds.length,2);
  // Unpriced imported packages must fail before any debit/order/removal.
  const oldMargin=manual.margin; manual.margin=0;
  const rejected=response(); await handler('/checkout')({user:{id:user.id},body:{}},rejected); manual.margin=oldMargin;
  assert.equal(rejected.statusCode,400); assert.match(rejected.body.error,/تسعيرها/);
  assert.equal(balance,17); assert.equal(orders.length,2); assert.equal(transactions.length,1);
  tx.user.findUnique=async()=>({...user,balance:0});balance=0;
  const insufficient=response();await handler('/checkout')({user:{id:user.id},body:{}},insufficient);
  assert.equal(insufficient.statusCode,400);assert.match(insufficient.body.error,/غير كاف/);assert.equal(orders.length,2);
 } finally {prisma.$transaction=originalTransaction;prisma.user.findUnique=originalUser;}
});

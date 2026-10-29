const {test}=require('node:test');
const assert=require('node:assert/strict');
const {googleAuthConfig}=require('./dist/utils/google-auth-config');
const disabled='149631802250-7n94rcr7nd1041iq06ck2310uctituve.apps.googleusercontent.com';
test('missing and known disabled Google clients are not offered to customers',()=>{
 assert.deepEqual(googleAuthConfig({}),{enabled:false,clientId:null});
 assert.deepEqual(googleAuthConfig({GOOGLE_CLIENT_ID:disabled}),{enabled:false,clientId:null});
});
test('a replacement client is read at runtime and no secret is exposed',()=>{
 assert.deepEqual(googleAuthConfig({GOOGLE_CLIENT_ID:' replacement.apps.googleusercontent.com ',GOOGLE_CLIENT_SECRET:'never-return-this'}),{enabled:true,clientId:'replacement.apps.googleusercontent.com'});
 assert.deepEqual(googleAuthConfig({GOOGLE_CLIENT_ID:'replacement.apps.googleusercontent.com',GOOGLE_AUTH_ENABLED:'false'}),{enabled:false,clientId:null});
 assert.deepEqual(googleAuthConfig({GOOGLE_CLIENT_ID:disabled,GOOGLE_AUTH_ENABLED:'true'}),{enabled:true,clientId:disabled});
});

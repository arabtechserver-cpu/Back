// Generate a fixed, reviewable deployment migration from the price-free snapshot.
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/data/zoalna-catalog.json');
const images = {
 'free-fire-id':'game_freefire.webp', 'pubg-id':'game_pubg.webp', 'mobile-legends':'game_mobilelegends.webp',
 'genshin-impact':'game_genshin.webp', 'jawaker':'game_jawaker.webp', 'yalla-ludo-id':'game_yallaludo.webp',
 'blood-strike':'game_bloodstrike.webp','lords-mobile':'game_lordsmobile.webp','redotpay':'game_redotpay.webp',
 'starlink-sub':'game_starlink.webp','tik-tok-offers':'game_tiktok.webp','2023fifa-mobile':'game_fifa.webp',
 'efootball':'game_pes.webp','clash-of-clans':'game_clashofclans.webp','clash-royale':'game_clashroyale.webp',
 'brawl-stars':'game_brawlstars.webp','xbox-card':'card_xbox.webp','steam-card':'card_steam.webp',
 'itunes-card':'card_itunes.webp','playstaion-card':'card_playstation.webp','razer-gold':'card_razergold.webp',
 'subscriber2':'card_subscriptions.webp',
};
const input = { ...catalog, products: catalog.products.map(product => ({ ...product, image: '/images/zoalna/' + (images[product.slug] || 'service_default_brand.webp') })) };
const sql = `-- Public names/options only. No source prices or provider credentials are imported.
-- Rows use the same tables as dashboard-created manual services and managed pages.
DO $seed$
DECLARE
  catalog jsonb := $catalog$${JSON.stringify(input)}$catalog$::jsonb;
  section jsonb; product jsonb; package jsonb; option_field jsonb; section_id text; page_id text;
  category_id text; service_id text; group_name text; setting_key text;
  page_ids jsonb; page_data jsonb; fields jsonb;
BEGIN
  FOR section IN SELECT value FROM jsonb_array_elements(catalog->'sections') LOOP
    section_id := section->>'id';
    page_id := 'zoalna-' || section_id;
    SELECT value::jsonb INTO page_data FROM "Setting"
      WHERE key LIKE 'store-page:%' AND value::jsonb->>'slug' = section->>'slug' LIMIT 1;
    IF page_data IS NOT NULL THEN page_id := page_data->>'id';
    ELSE
      page_data := jsonb_build_object('id',page_id,'slug',section->>'slug','title',section->>'title',
        'titleEn',section->>'titleEn','description','استعرض الخدمات والباقات واختر ما يناسبك.',
        'descriptionEn','Explore services and choose the right package.',
        'enabled',true,'navbar',true,'menu',true,'archived',false,
        'order',10 + (SELECT ord::int FROM jsonb_array_elements(catalog->'sections') WITH ORDINALITY a(value,ord) WHERE value->>'id'=section_id));
      INSERT INTO "Setting" (key,value,"updatedAt") VALUES ('store-page:'||page_id,page_data::text,CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
    END IF;
    INSERT INTO "Setting" (key,value,"updatedAt") VALUES ('store-page-slug:'||(section->>'slug'),page_id,CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
    INSERT INTO "Setting" (key,value,"updatedAt") VALUES ('catalog-source-page:zoalna:'||section_id,page_id,CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
  END LOOP;

  FOR product IN SELECT value FROM jsonb_array_elements(catalog->'products') LOOP
    group_name := product->>'name';
    SELECT id INTO category_id FROM "DhruCategory" WHERE name =
      (SELECT value->>'title' FROM jsonb_array_elements(catalog->'sections') WHERE value->>'id'=product->'pageIds'->>0) LIMIT 1;
    IF category_id IS NULL THEN
      category_id := md5('zoalna:category:'||(product->'pageIds'->>0))::uuid::text;
      INSERT INTO "DhruCategory" (id,name) VALUES (category_id,
        (SELECT value->>'title' FROM jsonb_array_elements(catalog->'sections') WHERE value->>'id'=product->'pageIds'->>0)) ON CONFLICT (id) DO NOTHING;
    END IF;
    -- Reuse an existing identical manual bundle rather than duplicating it in a new category.
    SELECT "categoryId" INTO section_id FROM "DhruService" WHERE "providerId" IS NULL AND "groupName"=group_name AND "categoryId" IS NOT NULL LIMIT 1;
    IF section_id IS NOT NULL THEN category_id := section_id; END IF;

    fields := '{}'::jsonb;
    IF product->'pageIds' ? 'top-up-id' THEN
      fields := jsonb_build_object('player_id',jsonb_build_object('label','معرف الحساب (Player ID)','fieldname','player_id','fieldtype','text','required',true));
      IF product->>'slug'='mobile-legends' THEN
        fields := fields || jsonb_build_object('zone_id',jsonb_build_object('label','معرف السيرفر (Zone ID)','fieldname','zone_id','fieldtype','text','required',true));
      ELSIF product->>'slug'='genshin-impact' THEN
        fields := fields || jsonb_build_object('server',jsonb_build_object('label','السيرفر','fieldname','server','fieldtype','select','required',true,'options',jsonb_build_array('Asia','Europe','America','TW/HK/MO')));
      END IF;
    ELSIF product->'pageIds' ? 'top-up-account' THEN
      fields := jsonb_build_object('account',jsonb_build_object('label','معرف الحساب أو البريد الإلكتروني','fieldname','account','fieldtype','text','required',true));
    ELSIF product->>'slug'='subscriber2' THEN
      fields := jsonb_build_object('email',jsonb_build_object('label','البريد الإلكتروني لاستلام الاشتراك','fieldname','email','fieldtype','email','required',true));
    END IF;

    FOR option_field IN SELECT value FROM jsonb_array_elements(product->'optionFields') LOOP
      fields := fields || jsonb_build_object(option_field->>'key',jsonb_build_object('label',option_field->>'label','fieldname',option_field->>'key','fieldtype','select','required',true,'options',option_field->'options'));
    END LOOP;

    FOR package IN SELECT value FROM jsonb_array_elements(product->'packages') LOOP
      SELECT id INTO service_id FROM "DhruService" WHERE "dhruId"='pkg_zoalna_'||(package->>'id')
        OR ("providerId" IS NULL AND "categoryId"=category_id AND "groupName"=group_name AND (name=package->>'name' OR "originalName"=package->>'name')) LIMIT 1;
      IF service_id IS NULL THEN
        service_id := md5('zoalna:service:'||(package->>'id'))::uuid::text;
        INSERT INTO "DhruService" (id,"dhruId",name,"originalName","groupName",credit,margin,time,"isActive","categoryId","requiresCustom","updatedAt")
          VALUES (service_id,'pkg_zoalna_'||(package->>'id'),package->>'name',package->>'name',group_name,0,0,'حسب تفاصيل الخدمة',true,category_id,NULLIF(fields,'{}'::jsonb)::text,CURRENT_TIMESTAMP)
          ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;

    SELECT jsonb_agg(value) INTO page_ids FROM "Setting" WHERE key IN
      (SELECT 'catalog-source-page:zoalna:'||value FROM jsonb_array_elements_text(product->'pageIds'));
    setting_key := 'store-placement:group:' || category_id || ':' ||
      -- The application uses encodeURIComponent, including UTF-8 byte encoding.
      (SELECT string_agg(CASE WHEN b BETWEEN 48 AND 57 OR b BETWEEN 65 AND 90 OR b BETWEEN 97 AND 122 OR chr(b) IN ('-','_','.','!','~','*',chr(39),'(',')') THEN chr(b) ELSE '%'||upper(lpad(to_hex(b),2,'0')) END,'' ORDER BY i)
       FROM (SELECT i,get_byte(convert_to(group_name,'UTF8'),i) b FROM generate_series(0,octet_length(group_name)-1) i) bytes);
    -- Keep explicit dashboard choices when a group already has a placement.
    INSERT INTO "Setting" (key,value,"updatedAt") VALUES (setting_key,jsonb_build_object('mode','selected','pageIds',page_ids)::text,CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
    INSERT INTO "Setting" (key,value,"updatedAt") VALUES (replace(setting_key,'store-placement:','catalog-image:'),product->>'image',CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
    INSERT INTO "Setting" (key,value,"updatedAt") VALUES (replace(setting_key,'store-placement:','catalog-product:'),product->>'slug',CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING;
  END LOOP;
END $seed$;
`;
const directory = path.resolve(__dirname,'../prisma/migrations/20261028000000_manual_store_catalog');
fs.mkdirSync(directory,{ recursive:true });
fs.writeFileSync(path.join(directory,'migration.sql'),sql);
console.log('Generated manual store catalog migration.');

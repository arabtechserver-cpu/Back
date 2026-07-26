# دليل تشغيل ونشر الموقع باستخدام Docker 🐳

يحتوي هذا المشروع على تهيئة كاملة للتشغيل والنشر الفوري باستخدام **Docker** و **Docker Compose**، مما يضمن تشغيل الواجهة (Frontend)، الخلفية (Backend)، وقاعدة البيانات (PostgreSQL) معاً بكل سهولة ودون تضارب في الإصدارات.

---

## 🏗️ مكونات بيئة التشغيل
يتكون المشروع من الخدمات التالية المهيأة داخل [docker-compose.yml](file:///d:/pj/ge/docker-compose.yml):
1. **postgres**: قاعدة بيانات PostgreSQL لإدارة العملاء، الطلبات، والخدمات.
2. **backend**: خادم Express.js متصل بقاعدة البيانات مع تهيئة المزامنة التلقائية والرفع الفوري.
3. **frontend**: تطبيق Next.js مع تهيئة الإنتاج ومطابقة المتصفح ومحركات البحث.

---

## 🚀 طريقة التشغيل المحلي (Development / Local Testing)

لتشغيل كامل الموقع على جهازك المحلي باستخدام Docker:

1. **تأكد من تثبيت Docker Desktop** على جهازك.
2. **افتح التيرمنال** في المجلد الرئيسي للمشروع.
3. **قم بتشغيل الأمر التالي** لبناء وتشغيل الحاويات:
   ```bash
   docker-compose up --build -d
   ```
4. **روابط الوصول**:
   - **الواجهة الأمامية للموقع (Frontend)**: `http://localhost:3000`
   - **لوحة التحكم (Admin Dashboard)**: `http://localhost:3000/admin`
   - **خلفية الموقع (Backend API)**: `http://localhost:5000`

---

## 🌐 النشر الفعلي على سيرفر خارجي (Production VPS Deployment)

عند النشر على خادم حقيقي (سيرفر خارجي مع دومين مخصص مثل `arab-tech1.online`)، اتبع الخطوات التالية لتهيئة روابط الـ API:

### 1. إعداد روابط النطاق (Domain Name / Reverse Proxy)
يُوصى بتوجيه خادم الويب (مثل Nginx أو Caddy) كوكيل عكسي (Reverse Proxy):
- الدومين الرئيسي للواجهة: `https://arab-tech1.online` (يوجه للداخل على البورت `3000`)
- دومين الخلفية (API): `https://spider-store-api.duckdns.org` أو دومين مخصص مثل `https://api.arab-tech1.online` (يوجه للداخل على البورت `5000`)

### 2. البناء للإنتاج مع رابط الـ API المخصص
عند تشغيل البناء على السيرفر الخارجي، يجب تمرير رابط خادم الـ API الحقيقي كمعامل بناء (Build Argument) لكي يتم تضمينه في ملفات Next.js الثابتة للعملاء:

قم بتعديل قسم `args` للخدمة `frontend` داخل ملف [docker-compose.yml](file:///d:/pj/ge/docker-compose.yml):
```yaml
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        - NEXT_PUBLIC_API_URL=https://api.yourdomain.com  # ضع رابط الـ API الخاص بسيرفرك هنا
```

أو تشغيل أمر البناء مباشرة مع المعامل:
```bash
docker-compose build --build-arg NEXT_PUBLIC_API_URL=https://api.yourdomain.com
docker-compose up -d
```

### 3. متغيرات البيئة المطلوبة
استخدم القيم التالية كمرجع عند النشر، مع استبدال القيم الحساسة بقيمك الفعلية:

**Backend**
```env
PORT=5000
NODE_ENV=production
JWT_SECRET=replace_with_a_long_random_secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_strong_admin_password
DATABASE_URL=postgres://user:password@host:port/database
CORS_ORIGIN=https://arab-tech1.online,https://spider-store-api.duckdns.org
DB_BACKUP_INTERVAL_MS=21600000
DB_BACKUP_START_DELAY_MS=60000
```

**Frontend**
```env
NEXT_PUBLIC_API_URL=https://spider-store-api.duckdns.org
NEXT_PUBLIC_SITE_URL=https://arab-tech1.online
```

---

## 💾 حفظ البيانات والمزامنة (Data Volumes & Migration)

1. **الرفع ومرفقات الصور**:
   يتم حفظ كافة الصور المرفوعة (الشعارات، أيقونات الأقسام، إلخ) داخل حجم مشترك (Volume) يسمى `backend-uploads` لضمان عدم ضياع الصور عند إعادة بناء الحاوية.
2. **قاعدة البيانات**:
   يتم حفظ بيانات الـ DB كاملة في الحجم `pgdata`.
3. **المزامنة التلقائية**:
   عند التشغيل لأول مرة مع PostgreSQL، سيقوم الباك إند تلقائياً بالآتي:
   - إنشاء الجداول ومزامنة التعديلات.
   - تهيئة حساب الأدمن الافتراضي:
     - **اسم المستخدم**: `admin`
     - **كلمة المرور الافتراضية**: `adminpassword123` (يمكنك تغييرها من متغيرات البيئة في `docker-compose.yml`).
   - استيراد ومزامنة البيانات السابقة الموجودة في ملف `database.json` المحلي تلقائياً وحفظها في قاعدة بيانات PostgreSQL!

---

## 🧹 أوامر مفيدة للإدارة

- **إيقاف تشغيل الحاويات**:
  ```bash
  docker-compose down
  ```
- **عرض سجلات التشغيل (Logs) لمتابعة الطلبات**:
  ```bash
  docker-compose logs -f backend
  ```
- **حذف الحاويات والبيانات بالكامل لإعادة التثبيت**:
  ```bash
  docker-compose down -v
  ```

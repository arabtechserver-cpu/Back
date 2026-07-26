# Spider Store — Game Charging & Digital Services Platform
## متجر سبايدر — منصة شحن الألعاب والخدمات الرقمية

---

### [العربية](#arabic-version) | [English](#english-version)

---

<a name="arabic-version"></a>
## 🇸🇦 النسخة العربية

**Spider Store** هو تطبيق ويب متكامل ومطور (PWA) مخصص لشحن الألعاب والخدمات الرقمية وتفعيل الاشتراكات. يدعم الموقع واجهة مستخدم حديثة وسريعة مع إمكانية التشغيل على الهواتف كتطبيق مثبت، إلى جانب لوحة تحكم كاملة للمسؤول لإدارة الأقسام والخدمات والطلبات والمحفظة الرقمية للمشتركين.

### 🚀 المميزات الرئيسية
- **دعم PWA:** إمكانية تثبيت الموقع كتطبيق جوال.
- **شحن الألعاب والشدات:** نظام مرن لشحن الألعاب عبر معرّف اللاعب (Player ID).
- **الاشتراكات والخدمات الرقمية:** شحن رصيد USDT، اشتراكات Canva، Netflix، وغيرها.
- **محفظة المستخدم الرقمية:** شحن رصيد المحفظة والدفع المباشر من خلالها وتتبع حركات الرصيد.
- **طرق دفع متعددة:** الدفع بالمحفظة أو عبر التحويل اليدوي (مثل فودافون كاش مصر).
- **لوحة تحكم الإدارة:** لوحة تحكم متكاملة لإضافة وتحديث الخدمات، قبول طلبات الشحن وتأكيد تحويلات المحفظة.
- **تهيئة محركات البحث (SEO) القوية:** دعم كامل للبيانات المهيكلة JSON-LD (Product, Organization, Website) وخريطة موقع ديناميكية لضمان سرعة الفهرسة في جوجل.

---

### 📂 هيكل المشروع
* **`backend/`**: واجهة برمجة التطبيقات (API) مبنية بـ Node.js و Express وقاعدة بيانات PostgreSQL مع نظام تخزين احتياطي ديناميكي في ملف JSON المحلي في حال عدم توفر قاعدة البيانات.
* **`frontend/`**: تطبيق ويب متكامل مبني باستخدام Next.js (App Router) و React.

---

### ⚙️ تشغيل المشروع عبر Docker Compose (الخيار الأسرع)
تأكد من تثبيت Docker و Docker Compose على جهازك، ثم شغّل الأمر التالي في المجلد الرئيسي للمشروع:

```bash
docker compose up --build
```
سيبدأ هذا الأمر بتشغيل:
1. قاعدة بيانات PostgreSQL على منفذ `5432`
2. الخادم الخلفي (Backend) على منفذ `5000`
3. الواجهة الأمامية (Frontend) على منفذ `3000`

---

### 🛠️ التشغيل اليدوي المحلي

#### 1. الخادم الخلفي (Backend)
انتقل إلى مجلد الباك إند وثبت الحزم:
```bash
cd backend
npm install
```
أنشئ ملف `.env` بناءً على `.env.example` واضبط المتغيرات:
```env
PORT=5000
JWT_SECRET=اكتب_مفتاح_التشفير_هنا
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
DATABASE_URL=postgres://user:password@localhost:5432/spiderstore
```
ثم شغل الخادم في وضع التطوير:
```bash
npm run dev
```

#### 2. الواجهة الأمامية (Frontend)
انتقل إلى مجلد الفرونت إند وثبت الحزم:
```bash
cd ../frontend
npm install
```
ثم شغل خادم التطوير لـ Next.js:
```bash
npm run dev
```
افتح المتصفح على [http://localhost:3000](http://localhost:3000) لمشاهدة المتجر.

---

### 📦 خطوات رفع المشروع إلى GitHub
لرفع هذا المشروع إلى مستودعك الخاص على GitHub، اتبع الخطوات التالية في سطر الأوامر (Terminal):

1. **تهيئة Git في المجلد الرئيسي للمشروع (`ge/`):**
   ```bash
   git init
   ```
2. **إضافة كافة الملفات للمستودع المؤقت:**
   ```bash
   git add .
   ```
3. **تسجيل التغييرات (Commit):**
   ```bash
   git commit -m "Initial commit: Spider Store frontend, backend, SEO and Docker configurations"
   ```
4. **ربط المستودع المحلي بمستودع GitHub الخاص بك:**
   *(استبدل الرابط أدناه برابط مستودعك الفعلي)*
   ```bash
   git branch -M main
   git remote add origin https://github.com/USERNAME/REPOSITORY-NAME.git
   ```
5. **رفع الملفات إلى GitHub:**
   ```bash
   git push -u origin main
   ```

---

<a name="english-version"></a>
## 🇺🇸 English Version

**Spider Store** is a fully-featured, Progressive Web Application (PWA) designed for game charging and digital services delivery. The platform features a responsive UI, direct mobile app installation, user wallets, manual/automatic checkout, and a complete Admin Panel to manage categories, services, packages, and transaction requests.

### 🚀 Key Features
- **PWA Ready:** Installable directly as a mobile app.
- **Game Charging System:** Direct recharge using player ID (e.g. PUBG Mobile UC, Free Fire).
- **Subscriptions & Digital Services:** USDT exchanging, Netflix, Canva Pro, etc.
- **User Wallet:** In-app balance system with transaction logs and automated payments.
- **Flexible Checkout:** Support for wallet payments and manual mobile transfer confirmations.
- **Comprehensive Admin Panel:** View statistics, manage services/packages, approve orders, and manage wallets.
- **Aggressive SEO & Rich Snippets:** Automated JSON-LD dynamic metadata generation (Product AggregateOffer, Organization, Breadcrumbs) and dynamic `sitemap.xml` for maximum search engine rankings.

---

### 📂 Repository Structure
* **`backend/`**: Node.js & Express API, PostgreSQL database with automated JSON file-based database fallback (`database.json`).
* **`frontend/`**: Next.js (App Router) & React single-page frontend application.

---

### ⚙️ Quick Start with Docker Compose
Ensure you have Docker and Docker Compose installed. Run the following command in the root repository directory:

```bash
docker compose up --build
```
This boots up:
1. PostgreSQL Database on port `5432`
2. Express API Backend on port `5000`
3. Next.js Frontend on port `3000`

---

### 🛠️ Manual Local Setup

#### 1. Backend Setup
Navigate to the backend directory and install dependencies:
```bash
cd backend
npm install
```
Create a `.env` file from `.env.example` and set your variables:
```env
PORT=5000
JWT_SECRET=your_jwt_secret_here
ADMIN_USERNAME=admin
ADMIN_PASSWORD=securepassword
DATABASE_URL=postgres://user:password@localhost:5432/spiderstore
```
Run the development server:
```bash
npm run dev
```

#### 2. Frontend Setup
Navigate to the frontend directory and install dependencies:
```bash
cd ../frontend
npm install
```
Start the Next.js development server:
```bash
npm run dev
```
Open your browser at [http://localhost:3000](http://localhost:3000).

---

### 📦 Uploading to GitHub
To push this codebase to your GitHub account, run the following commands in the project's root folder (`ge/`):

1. **Initialize Git Repository:**
   ```bash
   git init
   ```
2. **Stage all files:**
   ```bash
   git add .
   ```
3. **Commit the changes:**
   ```bash
   git commit -m "Initial commit: Spider Store frontend, backend, SEO and Docker configurations"
   ```
4. **Set remote origin repository:**
   *(Replace with your actual GitHub repository URL)*
   ```bash
   git branch -M main
   git remote add origin https://github.com/USERNAME/REPOSITORY-NAME.git
   ```
5. **Push files to GitHub:**
   ```bash
   git push -u origin main
   ```
https://github.com/minasamir1401/spider-store-back.git دي للباك ودي للفرونتhttps://github.com/minasamir1401/spider-store-front.git
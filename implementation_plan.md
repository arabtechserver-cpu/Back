# Implementation Plan - Custom Category Fields and UI Enhancements

This plan outlines the changes required to allow customizing the player charging account fields (بيانات الحساب المراد شحنه) at the category level, resolving order submission failures (400 Bad Request), and shrinking the size of the successful deposit modal in the wallet page.

## Proposed Changes

We will implement this in a structured manner across the backend and frontend components.

---

### Backend Components

We need to add a `fields` column to the `categories` table in both PostgreSQL and JSON databases, and update the API endpoints.

#### [MODIFY] [db.js](file:///d:/pj/ge/backend/db.js)
* Update the categories table schema in the PostgreSQL initialization code (`createTables`):
  * Add `fields TEXT DEFAULT '[]'` column to the categories schema.
  * Add the migration SQL: `ALTER TABLE categories ADD COLUMN IF NOT EXISTS fields TEXT DEFAULT '[]';`.
* Update the category sync code (`seedData`) to map the `fields` column correctly for inserts and updates.

#### [MODIFY] [categoryRoutes.js](file:///d:/pj/ge/backend/routes/categoryRoutes.js)
* Include `fields` parsing and formatting using `safeParseJson` when returning categories from the `GET /` route.
* Update `POST /` and `PUT /:id` category routers to accept `fields` from request body and insert/update it in the DB.

#### [MODIFY] [serviceRoutes.js](file:///d:/pj/ge/backend/routes/serviceRoutes.js)
* Update the `GET /:id` route to join the categories table and return `c.fields AS category_fields` so the frontend service client has access to the category-level fields.

---

### Frontend Components

#### [MODIFY] [AdminDashboardClient.js](file:///d:/pj/ge/frontend/src/app/admin/dashboard/AdminDashboardClient.js)
* Introduce state variables for Add Category Fields (`newCatFields`) and Edit Category Fields (`editCatFields`).
* Add field builder helper functions for Category fields (similar to the ones for Service fields).
* Update `handleAddCategory` and `handleEditCategory` requests to send the customized fields to the API.
* Inject the Custom Fields Builder UI block into the Add Category and Edit Category modals.

#### [MODIFY] [ServiceClient.js](file:///d:/pj/ge/frontend/src/app/service/[id]/ServiceClient.js)
* Update `serviceFields` computation to fall back to `service.category_fields` if the service has no custom fields configured.
* Normalize fields in `activeFields` to map `f.name` to `f.name || f.id` so both service and category level fields render and bind correctly.
* In `handleSubmit`, safely fall back for order submission properties:
  * `player_id`: use first active field name if `formData.player_id` is missing.
  * `phone`: use second active field name or first if `formData.phone` is missing.
  This resolves the 400 Bad Request error caused by missing mandatory order fields.

#### [MODIFY] [wallet/page.js](file:///d:/pj/ge/frontend/src/app/wallet/page.js)
* Shrink the size and spacing of the WhatsApp confirmation modal:
  * Reduce modal card `maxWidth` from `480px` to `380px`.
  * Reduce `padding` from `28px` to `18px`.
  * Reduce `gap` from `18px` to `12px`.
  * Decrease padding and font size of the WhatsApp action buttons and confirmation text block for a compact, clean look.

---

## Verification Plan

### Automated Tests
* Verify server starts and database migrations execute successfully.
* Verify API requests for categories and service details contain correct JSON payloads.

### Manual Verification
1. **Category Custom Fields:**
   * Open the Admin Dashboard, edit or add a category, and verify you can add, remove, and customize fields (e.g. Player ID, Email, Phone).
   * Save the category, verify it persists in the database.
2. **Service Field Inheritance & Order Submission:**
   * Create a service under that category without configuring service-level fields.
   * Open the service page on the customer site and verify it displays the category-level custom fields under "بيانات الحساب المراد شحنه".
   * Submit an order and verify it succeeds (no 400 Bad Request) and stores the correct player data.
3. **Wallet Success Modal Size:**
   * Submit a deposit request in the wallet page.
   * Verify the WhatsApp success modal is smaller, has tighter spacing, and is visually balanced.

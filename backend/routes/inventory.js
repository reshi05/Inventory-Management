// routes/inventory.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// Function to log audit entries
async function logAudit(product_id, action, changed_by, details) {
  const sql = `INSERT INTO inventory_audit (product_id, action, changed_by, change_details)
               VALUES (?, ?, ?, ?)`;
  await db.execute(sql, [
    product_id || null,
    action,
    changed_by || 'system',
    JSON.stringify(details || {})
  ]);
}

// ✅ GET all products
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, c.name AS category, s.name AS supplier 
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       ORDER BY p.id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ GET product by ID
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ ADD product
router.post('/', async (req, res) => {
  const {
    product_name,
    sku,
    category_id,
    supplier_id,
    quantity = 0,
    price = 0.0,
    location,
    changed_by
  } = req.body;

  if (!product_name || !sku)
    return res.status(400).json({ error: 'product_name and sku required' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Check for duplicate SKU
    const [existing] = await conn.execute('SELECT id FROM products WHERE sku = ?', [sku]);
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'SKU already exists' });
    }

    console.log("Incoming data:", { product_name, sku, category_id, supplier_id, quantity, price, location });

    // Convert IDs safely
    const catId = parseInt(category_id);
    const supId = parseInt(supplier_id);

    // Validate category ID
    const [existingCat] = await conn.execute("SELECT id FROM categories WHERE id = ?", [catId]);
    const validCategoryId = existingCat.length > 0 ? catId : null;

    // Validate supplier ID
    const [existingSup] = await conn.execute("SELECT id FROM suppliers WHERE id = ?", [supId]);
    const validSupplierId = existingSup.length > 0 ? supId : null;

    console.log("Resolved IDs before insert:", { validCategoryId, validSupplierId });

    // Perform insert
    const [result] = await conn.execute(
      `INSERT INTO products (product_name, sku, category_id, supplier_id, quantity, price, location)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        product_name,
        sku,
        validCategoryId,
        validSupplierId,
        quantity || 0,
        price || 0,
        location || null
      ]
    );

    console.log("Insert result:", result);

    const newId = result.insertId;
    await logAudit(newId, 'ADD', changed_by, { product_name, sku, quantity, price, location });
    await conn.commit();

    console.log("✅ Product committed successfully with ID:", newId);
    res.status(201).json({ id: newId, message: 'Product added successfully!' });
  } catch (err) {
    await conn.rollback();
    console.error("❌ Insert failed:", err);
    res.status(500).json({ error: err.sqlMessage || 'Server error' });
  } finally {
    conn.release();
  }
});

// ✅ UPDATE product
router.put('/:id', async (req, res) => {
  const id = req.params.id;
  const changed_by = req.body.changed_by || 'unknown';
  const allowed = ['product_name', 'sku', 'category_id', 'supplier_id', 'quantity', 'price', 'location'];
  const updates = [];
  const params = [];

  for (const key of allowed) {
    if (req.body.hasOwnProperty(key)) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (req.body.sku) {
      const [dup] = await conn.execute('SELECT id FROM products WHERE sku = ? AND id <> ?', [req.body.sku, id]);
      if (dup.length) {
        await conn.rollback();
        return res.status(409).json({ error: 'SKU already used by another product' });
      }
    }

    params.push(id);
    const sql = `UPDATE products SET ${updates.join(', ')} WHERE id = ?`;
    const [result] = await conn.execute(sql, params);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Product not found' });
    }

    await logAudit(id, 'UPDATE', changed_by, { updated_fields: req.body });
    await conn.commit();
    res.json({ message: 'Product updated successfully!' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

// ✅ DELETE product
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  const changed_by = req.body?.changed_by || req.query.changed_by || 'unknown';
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [prodRows] = await conn.execute('SELECT id, product_name, sku FROM products WHERE id = ?', [id]);
    if (prodRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = prodRows[0];
    await conn.execute('DELETE FROM products WHERE id = ?', [id]);
    await logAudit(id, 'DELETE', changed_by, { product_name: product.product_name, sku: product.sku });

    await conn.commit();
    res.json({ message: 'Product deleted successfully!' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

// ✅ ADJUST product quantity
router.post('/:id/adjust', async (req, res) => {
  const id = req.params.id;
  const { delta, changed_by } = req.body;

  if (typeof delta !== 'number')
    return res.status(400).json({ error: 'delta numeric required' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute('SELECT quantity FROM products WHERE id = ? FOR UPDATE', [id]);
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Product not found' });
    }

    let newQty = rows[0].quantity + delta;
    if (newQty < 0) newQty = 0;

    await conn.execute('UPDATE products SET quantity = ? WHERE id = ?', [newQty, id]);
    await logAudit(id, 'QUANTITY_ADJUST', changed_by || 'unknown', { delta, new_quantity: newQty });

    await conn.commit();
    res.json({ message: 'Quantity adjusted successfully!', quantity: newQty });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;

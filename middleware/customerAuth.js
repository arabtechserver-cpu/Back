const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/security');

const customerAuth = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ message: 'يرجى تسجيل الدخول أولاً.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'التوكن غير متوفر.' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.role !== 'customer') {
      return res.status(403).json({ message: 'Customer access is required.' });
    }
    req.customer = decoded;
    // For compatibility with some routes that expect req.user
    req.user = decoded; 
    next();
  } catch (error) {
    return res.status(403).json({ message: 'جلسة العمل منتهية، يرجى تسجيل الدخول مجدداً.' });
  }
};

module.exports = customerAuth;

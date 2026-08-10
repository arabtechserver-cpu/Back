const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/security');

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ message: 'Authorization header is missing.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token is missing.' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Administrator access is required.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token.' });
  }
};

module.exports = authMiddleware;

const { runQuery, getQuery } = require('../db');

/**
 * Service to log all API requests from resellers.
 */
class ApiLogService {
  /**
   * Log an API request and response
   * @param {number} customerId - The reseller customer ID
   * @param {string} apiKey - The API key used
   * @param {string} endpoint - The action/endpoint called (e.g., 'accountinfo', 'placeorder')
   * @param {object} requestBody - The request payload
   * @param {number} responseStatus - HTTP status or error code
   * @param {string} ipAddress - IP address of the caller
   */
  static async logRequest(customerId, apiKey, endpoint, requestBody, responseStatus, ipAddress) {
    try {
      const sanitizedBody = { ...requestBody };
      // Remove sensitive data before logging if any
      if (sanitizedBody.password) sanitizedBody.password = '***';

      await runQuery(
        `INSERT INTO api_logs (customer_id, api_key, endpoint, request_body, response_status, ip_address) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          apiKey,
          endpoint,
          JSON.stringify(sanitizedBody),
          responseStatus,
          ipAddress
        ]
      );
    } catch (error) {
      console.error('[ApiLogService] Failed to log API request:', error.message);
    }
  }

  /**
   * Fetch logs for a specific customer (reseller)
   * @param {number} customerId 
   * @param {number} limit 
   * @param {number} offset 
   */
  static async getLogsForCustomer(customerId, limit = 50, offset = 0) {
    try {
      if (!customerId) return [];
      // In SQLite/JSON fallback we use simplified query, in Postgres it supports pagination natively
      // Since db.js abstracts it, we'll try standard SQL
      return await getQuery('SELECT * FROM api_logs WHERE customer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [customerId, limit, offset], true) || [];
    } catch (error) {
      console.error('[ApiLogService] Failed to fetch logs:', error.message);
      return [];
    }
  }

  /**
   * Fetch logs for Admin Dashboard
   * @param {number} limit 
   * @param {number} offset 
   */
  static async getAllLogs(limit = 100, offset = 0) {
    try {
      // Assuming db.js handles `allQuery` or passing true to `getQuery` returns an array
      const { allQuery } = require('../db');
      return await allQuery('SELECT api_logs.*, customers.username FROM api_logs LEFT JOIN customers ON api_logs.customer_id = customers.id ORDER BY api_logs.created_at DESC LIMIT ? OFFSET ?', [limit, offset]) || [];
    } catch (error) {
      console.error('[ApiLogService] Failed to fetch all logs:', error.message);
      return [];
    }
  }
}

module.exports = ApiLogService;

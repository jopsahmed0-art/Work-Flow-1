/**
 * أدوات HTTP مشتركة: CORS مفتوح + أخطاء بصيغة {"error":"..."} برسائل عربية + أكواد صحيحة.
 */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, obj) {
  cors(res);
  res.status(status).json(obj);
}

function error(res, status, message) {
  json(res, status, { error: message });
}

module.exports = { cors, json, error };

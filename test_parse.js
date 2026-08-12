const dhru = require('./services/dhruClient.js');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('imei_response.json', 'utf8'));
const services = dhru.parseDhruServices(data, 'imei');
const buggy = services.find(s => s.name && s.name.includes('Nooox Tool'));

console.log("Buggy service name:", buggy.name);
console.log("Buggy service time extracted by dhruClient:", buggy.time);

const packageObject = {
    api_delivery_time: buggy.time || '',
    name: buggy.name
};

console.log("Package object api_delivery_time:", packageObject.api_delivery_time);

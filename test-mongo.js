const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
console.log("URI:", uri ? uri.substring(0,20) + "..." : "missing");
const client = new MongoClient(uri);
console.log("Connecting...");
client.connect().then(() => {
  console.log("Connected!");
  process.exit(0);
}).catch(err => {
  console.log("Error:", err.message);
  process.exit(1);
});

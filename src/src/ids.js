const crypto = require("node:crypto");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateOpaqueId() {
  let out = "";
  const bytes = crypto.randomBytes(26);
  for (let index = 0; index < 26; index += 1) {
    out += CROCKFORD[bytes[index] % CROCKFORD.length];
  }
  return out;
}

module.exports = {
  generateOpaqueId,
};

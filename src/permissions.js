// mod ranks alongside common (per-server grants use admin/operator/mod;
// the guild-wide roles.json system uses admin/operator/common) -- same
// rank, different vocabulary depending on which one resolved the tier, so
// hasAccess works the same regardless of which resolver produced it.
const TIER_RANK = { common: 1, mod: 1, operator: 2, admin: 3 };

function findGuildRoles(guilds, guildId) {
  return guilds.find((guild) => guild.guildId === guildId) || null;
}

function memberMatchesTier(member, tier) {
  if (!tier) return false;
  return (
    member.roleIds.some((id) => tier.roleIds.includes(id)) ||
    tier.userIds.includes(member.userId)
  );
}

function resolveTier(member, roles) {
  if (!roles) return null;
  if (memberMatchesTier(member, roles.admin)) return 'admin';
  if (memberMatchesTier(member, roles.operator)) return 'operator';
  if (memberMatchesTier(member, roles.common)) return 'common';
  return null;
}

// Same shape and matching logic as resolveTier, but against a single
// server's own tierGrants (admin/operator/mod) instead of a whole guild's
// roles.json entry -- used for agent-routed servers, where the server's
// owner decides access instead of the guild's admins.
function resolveTierFromGrants(member, tierGrants) {
  if (!tierGrants) return null;
  if (memberMatchesTier(member, tierGrants.admin)) return 'admin';
  if (memberMatchesTier(member, tierGrants.operator)) return 'operator';
  if (memberMatchesTier(member, tierGrants.common) || memberMatchesTier(member, tierGrants.mod)) return 'common';
  return null;
}

function hasAccess(memberTier, requiredTier) {
  if (!memberTier) return false;
  return TIER_RANK[memberTier] >= TIER_RANK[requiredTier];
}

module.exports = { resolveTier, resolveTierFromGrants, hasAccess, findGuildRoles, TIER_RANK };

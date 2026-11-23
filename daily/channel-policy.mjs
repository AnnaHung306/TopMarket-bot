import {PermissionFlagsBits} from 'discord.js';

// This is a safety gate only; it never changes Discord permissions. Explicit
// exceptions are limited to the already configured MOD and bot identities.
export function assertActivityChannelPolicy({guild,channel,modChannel,moderatorRoleId,botRoleId,botId,boatId,publicEnabled,unverifiedRoleId,verifiedRoleId=null,testUserId}) {
  const view=PermissionFlagsBits.ViewChannel;
  const allowed=new Set([moderatorRoleId,botRoleId,botId,boatId,...(testUserId?[testUserId]:[])]);
  const requirePrivate=(target,error)=>{
    if(!target.permissionOverwrites.cache.get(guild.id)?.deny.has(view) || !target.permissionOverwrites.cache.get(moderatorRoleId)?.allow.has(view)) throw Error(error);
    for(const overwrite of target.permissionOverwrites.cache.values())
      if(overwrite.allow.has(view) && !allowed.has(overwrite.id)) throw Error(`${error}_EXTRA_ACCESS`);
  };
  // Public activities must never share the private moderator channel.
  if(publicEnabled) {
    if(channel.id===modChannel.id) throw Error('DAILY_PUBLIC_MOD_CHANNEL_COLLISION');
    requirePrivate(modChannel,'DAILY_PRIVATE_MOD_CHANNEL_REQUIRED');
    if(!unverifiedRoleId || unverifiedRoleId===guild.id || allowed.has(unverifiedRoleId)) throw Error('DAILY_UNVERIFIED_ROLE_INVALID');
    const unverified=guild.roles.cache.get(unverifiedRoleId);
    if(!unverified || unverified.permissions.has(PermissionFlagsBits.Administrator)) throw Error('DAILY_UNVERIFIED_ROLE_INVALID');
    if (verifiedRoleId) {
      if (verifiedRoleId===unverifiedRoleId || verifiedRoleId===guild.id || allowed.has(verifiedRoleId)) throw Error('DAILY_VERIFIED_ROLE_INVALID');
      const verified=guild.roles.cache.get(verifiedRoleId);
      if (!verified || verified.permissions.has(PermissionFlagsBits.Administrator)) throw Error('DAILY_VERIFIED_ROLE_INVALID');
      allowed.add(verifiedRoleId);
    }
    const everyone=channel.permissionOverwrites.cache.get(guild.id);
    const excluded=channel.permissionOverwrites.cache.get(unverifiedRoleId);
    const verified=verifiedRoleId && channel.permissionOverwrites.cache.get(verifiedRoleId);
    const audienceSafe=verifiedRoleId ? everyone?.deny.has(view) && !everyone.allow.has(view) && verified?.allow.has(view) && !verified.deny.has(view) : everyone?.allow.has(view) && !everyone.deny.has(view);
    if(!audienceSafe || !excluded?.deny.has(view) || excluded.allow.has(view)) throw Error('DAILY_PUBLIC_CHANNEL_POLICY_INVALID');
    if(channel.permissionsFor(unverified)?.has(view)!==false) throw Error('DAILY_UNVERIFIED_CAN_VIEW');
    for(const overwrite of channel.permissionOverwrites.cache.values())
      if(overwrite.allow.has(view) && overwrite.id!==guild.id && !allowed.has(overwrite.id)) throw Error('DAILY_PUBLIC_CHANNEL_EXTRA_ACCESS');
  } else {
    // Preserve private test behavior, while keeping MOD reports private.
    if(!modChannel.permissionOverwrites.cache.get(guild.id)?.deny.has(view) || !modChannel.permissionOverwrites.cache.get(moderatorRoleId)?.allow.has(view)) throw Error('DAILY_PRIVATE_MOD_CHANNEL_REQUIRED');
    requirePrivate(channel,'DAILY_PRIVATE_CHANNEL_REQUIRED');
  }
}

import {PermissionFlagsBits} from 'discord.js';

// Enumerate every guild member. Any error, incomplete snapshot, or unverified
// member with effective access prevents the activity from opening.
export async function assertUnverifiedCannotView({guild,channel,unverifiedRoleId}) {
  if (!Number.isSafeInteger(guild.memberCount) || guild.memberCount < 1) throw Error('DAILY_MEMBER_COUNT_UNAVAILABLE');
  const expected=guild.memberCount;
  let after, count=0;
  const seen=new Set();
  for (let page=0;page<100;page++) {
    const members=await guild.members.list({limit:1000,after,cache:false});
    if (!members || typeof members.values!=='function' || typeof members.lastKey!=='function') throw Error('DAILY_MEMBER_SCAN_INCOMPLETE');
    for (const member of members.values()) {
      if (!member?.roles?.cache || !member.id || seen.has(member.id)) throw Error('DAILY_MEMBER_SCAN_INCOMPLETE');
      seen.add(member.id);
      if (member.roles.cache.has(unverifiedRoleId) && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)!==false) throw Error('DAILY_UNVERIFIED_MEMBER_CAN_VIEW');
      count++;
    }
    if (members.size<1000) {
      if (count!==expected || guild.memberCount!==expected) throw Error('DAILY_MEMBER_SCAN_INCOMPLETE');
      return;
    }
    const next=members.lastKey();
    if (!next || next===after) throw Error('DAILY_MEMBER_SCAN_INCOMPLETE');
    after=next;
  }
  throw Error('DAILY_MEMBER_SCAN_INCOMPLETE');
}

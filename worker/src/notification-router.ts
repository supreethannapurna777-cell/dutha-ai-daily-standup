export type NotificationChannel = 'whatsapp' | 'email' | 'teams' | 'slack';

export interface ChannelPreference {
	channel: NotificationChannel;
	enabled: boolean;
	isPrimary: boolean;
	connected: boolean;
}

export interface NotificationRoute {
	primary: NotificationChannel | null;
	fallbacks: NotificationChannel[];
	skipped: NotificationChannel[];
}

const DEFAULT_ORDER: NotificationChannel[] = ['whatsapp', 'email', 'teams', 'slack'];

export function planNotificationRoute(preferences: ChannelPreference[]): NotificationRoute {
	const byChannel = new Map(preferences.map((item) => [item.channel, item]));
	const available = DEFAULT_ORDER.filter((channel) => {
		const item = byChannel.get(channel);
		return Boolean(item?.enabled && item.connected);
	});
	available.sort((left, right) => Number(Boolean(byChannel.get(right)?.isPrimary)) - Number(Boolean(byChannel.get(left)?.isPrimary)));
	return {
		primary: available[0] ?? null,
		fallbacks: available.slice(1),
		skipped: DEFAULT_ORDER.filter((channel) => !available.includes(channel)),
	};
}

export async function notificationRouteForMember(db: D1Database, memberId: number): Promise<NotificationRoute> {
	const rows = await db.prepare(`
		SELECT p.channel, p.enabled, p.is_primary,
			CASE WHEN i.id IS NOT NULL OR (p.channel='email' AND a.email IS NOT NULL) THEN 1 ELSE 0 END AS connected
		FROM employee_channel_preferences p
		LEFT JOIN channel_identities i ON i.team_member_id=p.team_member_id AND i.channel=p.channel
		LEFT JOIN employee_accounts a ON a.team_member_id=p.team_member_id
		WHERE p.team_member_id=?
	`).bind(memberId).all<{ channel: NotificationChannel; enabled: number; is_primary: number; connected: number }>();
	return planNotificationRoute(rows.results.map((row) => ({ channel: row.channel, enabled: row.enabled === 1, isPrimary: row.is_primary === 1, connected: row.connected === 1 })));
}

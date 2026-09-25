import { describe, expect, it } from 'vitest';
import { planNotificationRoute } from '../src/notification-router';

describe('notification router', () => {
	it('uses the connected primary channel and retains ordered fallbacks', () => {
		expect(planNotificationRoute([
			{ channel: 'whatsapp', enabled: true, isPrimary: false, connected: true },
			{ channel: 'email', enabled: true, isPrimary: true, connected: true },
			{ channel: 'teams', enabled: true, isPrimary: false, connected: false },
		])).toEqual({ primary: 'email', fallbacks: ['whatsapp'], skipped: ['teams', 'slack'] });
	});

	it('never routes through disabled or disconnected channels', () => {
		expect(planNotificationRoute([
			{ channel: 'whatsapp', enabled: false, isPrimary: true, connected: true },
			{ channel: 'email', enabled: true, isPrimary: false, connected: false },
		])).toEqual({ primary: null, fallbacks: [], skipped: ['whatsapp', 'email', 'teams', 'slack'] });
	});
});

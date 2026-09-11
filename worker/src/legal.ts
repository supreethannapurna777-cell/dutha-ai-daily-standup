const CONTACT_EMAIL = "supreethannapurna807@gmail.com";
const EFFECTIVE_DATE = "11 September 2026";


function legalPage(
	title: string,
	content: string,
): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title} | Dutha AI Daily Standup</title>
	<style>
		:root {
			font-family: system-ui, -apple-system, BlinkMacSystemFont,
				"Segoe UI", sans-serif;
			color: #172b4d;
			background: #f4f7fb;
		}

		body {
			margin: 0;
			line-height: 1.65;
		}

		main {
			max-width: 850px;
			margin: 40px auto;
			padding: 40px;
			background: white;
			border-radius: 14px;
			box-shadow: 0 8px 30px rgba(23, 43, 77, 0.08);
		}

		h1, h2 {
			color: #173f73;
		}

		h1 {
			margin-bottom: 4px;
		}

		.meta {
			color: #5d6b82;
			margin-top: 0;
		}

		a {
			color: #145da0;
		}

		nav {
			margin-top: 32px;
			padding-top: 20px;
			border-top: 1px solid #dfe5ee;
		}

		@media (max-width: 700px) {
			main {
				margin: 0;
				padding: 24px;
				border-radius: 0;
			}
		}
	</style>
</head>
<body>
	<main>
		<h1>${title}</h1>
		<p class="meta">
			Dutha AI Daily Standup · Effective ${EFFECTIVE_DATE}
		</p>

		${content}

		<nav>
			<a href="/privacy">Privacy Policy</a> ·
			<a href="/data-deletion">Data Deletion</a> ·
			<a href="/terms">Terms of Service</a>
		</nav>
	</main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; " +
				"frame-ancestors 'none'; base-uri 'none'",
		},
	});
}


export function privacyPolicyResponse(): Response {
	return legalPage(
		"Privacy Policy",
		`
		<p>
			Dutha AI Daily Standup is a private workforce productivity
			application that collects and organises daily stand-up updates
			received through the WhatsApp Business Platform.
		</p>

		<h2>Information we process</h2>
		<ul>
			<li>WhatsApp phone number and profile name.</li>
			<li>Daily stand-up replies sent to the application.</li>
			<li>
				Extracted work information such as tasks, blockers,
				dependencies, coordination needs and expected completion.
			</li>
			<li>
				Technical delivery information such as WhatsApp message
				identifiers and timestamps.
			</li>
		</ul>

		<h2>How we use information</h2>
		<p>Information is used only to:</p>
		<ul>
			<li>receive and organise authorised team stand-up updates;</li>
			<li>identify pending responses and issue configured reminders;</li>
			<li>display progress on a protected management dashboard;</li>
			<li>maintain delivery, processing and security records.</li>
		</ul>

		<h2>Legal basis and consent</h2>
		<p>
			The service is intended for authorised organisational team
			members who have been informed that WhatsApp is being used for
			daily stand-up collection. Users may stop participating or
			request deletion of their information.
		</p>

		<h2>Sharing and service providers</h2>
		<p>
			We do not sell personal information. Information is processed
			through Meta's WhatsApp Business Platform and Cloudflare
			infrastructure only as required to operate and secure the
			service. Access to the management dashboard is restricted.
		</p>

		<h2>Retention</h2>
		<p>
			Information is retained only while needed for stand-up
			operations, reporting, security and legitimate administrative
			requirements. Users may request deletion at any time.
		</p>

		<h2>Security</h2>
		<p>
			The service uses HTTPS, webhook-signature verification,
			secret-managed credentials, authenticated dashboard access and
			restricted database access. No internet service can guarantee
			absolute security, but reasonable safeguards are maintained.
		</p>

		<h2>Your choices and rights</h2>
		<p>
			You may request access, correction or deletion of your
			information by following the
			<a href="/data-deletion">Data Deletion instructions</a>.
			Never send passwords, access tokens or one-time passwords in a
			deletion request.
		</p>

		<h2>Children</h2>
		<p>
			This workforce service is not intended for children under
			18 years of age.
		</p>

		<h2>Changes to this policy</h2>
		<p>
			This policy may be updated when the service or applicable
			requirements change. The effective date shown above identifies
			the latest published version.
		</p>

		<h2>Contact</h2>
		<p>
			For privacy questions, contact
			<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
		</p>
		`,
	);
}


export function dataDeletionResponse(): Response {
	return legalPage(
		"User Data Deletion Instructions",
		`
		<p>
			Users may request deletion of information associated with their
			WhatsApp account from Dutha AI Daily Standup.
		</p>

		<h2>How to submit a request</h2>
		<ol>
			<li>
				Email
				<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
			</li>
			<li>
				Use the subject:
				<strong>Dutha Standup Data Deletion Request</strong>.
			</li>
			<li>
				Provide your name and WhatsApp number in international
				format so that the correct records can be identified.
			</li>
			<li>
				Send the request from an email address through which we can
				safely confirm the request.
			</li>
		</ol>

		<h2>What happens next</h2>
		<p>
			We may request reasonable verification to prevent unauthorised
			deletion. Do not send a password, access token, OTP or other
			login credential.
		</p>
		<p>
			After verification, applicable stand-up messages, processed
			updates and roster information associated with the requester
			will be deleted or anonymised. We aim to complete valid requests
			within 30 days and will confirm when processing is complete.
		</p>

		<h2>Information that may be retained</h2>
		<p>
			Limited records may be retained when required for security,
			fraud prevention, legal compliance or establishing that a
			deletion request was completed. Such records will not be used
			for routine stand-up reporting.
		</p>

		<h2>Contact</h2>
		<p>
			Questions about deletion requests may be sent to
			<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
		</p>
		`,
	);
}


export function termsOfServiceResponse(): Response {
	return legalPage(
		"Terms of Service",
		`
		<p>
			These terms govern use of Dutha AI Daily Standup, a private
			service for collecting and organising authorised team stand-up
			updates through WhatsApp.
		</p>

		<h2>Authorised use</h2>
		<p>
			You may use the service only if you are an authorised team
			member or administrator. You must provide accurate information
			and use the service lawfully and professionally.
		</p>

		<h2>Prohibited use</h2>
		<p>You must not:</p>
		<ul>
			<li>attempt to access another person's records;</li>
			<li>interfere with the service or bypass its security;</li>
			<li>submit unlawful, abusive or malicious content;</li>
			<li>use the service for unsolicited messaging or spam.</li>
		</ul>

		<h2>Availability</h2>
		<p>
			The service may be changed, suspended or unavailable during
			maintenance, provider outages or security incidents. No
			uninterrupted availability is guaranteed.
		</p>

		<h2>Privacy</h2>
		<p>
			Use of personal information is described in the
			<a href="/privacy">Privacy Policy</a>. Data deletion requests
			may be submitted using the
			<a href="/data-deletion">Data Deletion instructions</a>.
		</p>

		<h2>Limitation</h2>
		<p>
			The service supports operational reporting and does not replace
			formal employment, legal, financial or compliance records.
		</p>

		<h2>Contact</h2>
		<p>
			Questions about these terms may be sent to
			<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
		</p>
		`,
	);
}
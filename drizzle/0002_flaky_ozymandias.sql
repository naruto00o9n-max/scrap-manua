CREATE TABLE `integrationAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`service` varchar(64) NOT NULL,
	`alertSeverity` enum('warning','critical') NOT NULL DEFAULT 'warning',
	`fingerprint` varchar(128) NOT NULL,
	`message` text NOT NULL,
	`recipientDiscordUserId` varchar(32),
	`alertDeliveryStatus` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`deliveredAt` timestamp,
	CONSTRAINT `integrationAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `integrationAlerts_service_createdAt_idx` ON `integrationAlerts` (`service`,`createdAt`);
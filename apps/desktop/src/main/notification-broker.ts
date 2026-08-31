import { Notification, BrowserWindow } from 'electron';
import type { SessionStatusResult, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { Repositories } from '@spawnea/db';

export interface NotificationBrokerOptions {
  repositories: Repositories;
  logger?: Logger;
}

export class NotificationBroker {
  private readonly repos: Repositories;
  private readonly logger: Logger;
  private activeSessionId: string | null = null;
  private readonly notifiedAlerts = new Map<string, { alertId: string; timestamp: number }>();

  constructor(options: NotificationBrokerOptions) {
    this.repos = options.repositories;
    this.logger = options.logger || createLogger('NotificationBroker');
  }

  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    if (sessionId) {
      // Clear alert when user focuses/attaches to the session
      this.notifiedAlerts.delete(sessionId);
    }
  }

  /**
   * Generates a deterministic alert identifier for deduplication.
   */
  getAlertId(sessionId: string, result: SessionStatusResult): string {
    const promptOrReason = (result.detectedPrompt || result.reason || '').trim();
    return `${sessionId}:${result.status}:${promptOrReason}`;
  }

  /**
   * Clears any recorded alert for a session.
   */
  clearAlert(sessionId: string): void {
    this.notifiedAlerts.delete(sessionId);
  }

  /**
   * Dispatches an OS desktop notification if the session is not the active/focused session,
   * and deduplicates so the exact same prompt is not repeatedly alerted.
   */
  async notifyStatusAlert(sessionId: string, result: SessionStatusResult): Promise<boolean> {
    // If not an attention status, clear any previous alert so future prompts will notify
    if (result.status !== 'needs_input' && result.status !== 'error') {
      this.notifiedAlerts.delete(sessionId);
      return false;
    }

    const alertId = this.getAlertId(sessionId, result);
    const existingAlert = this.notifiedAlerts.get(sessionId);

    // If we have already dispatched a notification for this exact prompt/alert, do not repeat
    if (existingAlert && existingAlert.alertId === alertId) {
      this.logger.debug('Skipping duplicate notification for already-notified prompt', { sessionId, alertId });
      return false;
    }

    // Do not alert if user is actively interacting with this exact session in a focused window
    const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const isWindowFocused = mainWindow ? mainWindow.isFocused() : false;

    if (this.activeSessionId === sessionId && isWindowFocused) {
      this.logger.debug('Skipping notification for currently active focused session', { sessionId });
      return false;
    }

    if (!Notification.isSupported()) {
      this.logger.debug('OS notifications are not supported in this environment');
      // Still mark as notified so we don't spam logs
      this.notifiedAlerts.set(sessionId, { alertId, timestamp: Date.now() });
      return false;
    }

    const session = await this.repos.sessions.findById(sessionId);
    const sessionName = session ? session.name : sessionId;

    let title = `Spawnea: Attention Required`;
    let body = `Session '${sessionName}' requires attention`;

    if (result.status === 'needs_input') {
      title = `Spawnea: Input Required`;
      body = result.detectedPrompt
        ? `${sessionName}: ${result.detectedPrompt}`
        : `${sessionName} is waiting for confirmation or input`;
    } else if (result.status === 'error') {
      title = `Spawnea: Session Error`;
      body = `${sessionName}: ${result.reason || 'Process exited with error'}`;
    }

    try {
      const notification = new Notification({
        title,
        body,
        urgency: 'critical',
      });

      notification.on('click', () => {
        this.logger.info('Notification clicked, focusing window and activating session', { sessionId });
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('session:activate', sessionId);
        }
      });

      notification.show();
      this.notifiedAlerts.set(sessionId, { alertId, timestamp: Date.now() });
      this.logger.info('Dispatched OS notification alert', { sessionId, status: result.status, title });
      return true;
    } catch (err) {
      this.logger.warn('Failed to display OS notification', { sessionId, error: err });
      return false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from './env';

export interface SendSmsOptions {
  to: string;
  message: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger('SmsService');

  async sendOtp(phone: string, code: string): Promise<boolean> {
    // Twilio Trial Accounts require standard verification template text:
    const message = `Your verification code is ${code}`;
    return this.send({ to: phone, message });
  }

  async send(options: SendSmsOptions): Promise<boolean> {
    const env = loadEnv();
    let cleanPhone = options.to.replace(/[^\d+]/g, '').trim();
    // If user provided a standard 10-digit number without country code, prefix with default +91
    if (/^\d{10}$/.test(cleanPhone)) {
      cleanPhone = `+91${cleanPhone}`;
    } else if (/^0\d{10}$/.test(cleanPhone)) {
      cleanPhone = `+91${cleanPhone.slice(1)}`;
    } else if (!cleanPhone.startsWith('+')) {
      cleanPhone = `+${cleanPhone}`;
    }

    if (env.SMS_DRIVER === 'twilio') {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        this.logger.error('Twilio SMS requested but credentials missing in services/api/.env');
        return false;
      }
      try {
        const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

        // Preferred: Twilio Verify Service (Guaranteed SMS delivery worldwide, works with Indian DLT and Trial accounts)
        if (env.TWILIO_VERIFY_SERVICE_SID) {
          const verifyUrl = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
          const vBody = new URLSearchParams({
            To: cleanPhone,
            Channel: 'sms',
          });
          const vRes = await fetch(verifyUrl, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: vBody.toString(),
          });
          if (vRes.ok) {
            this.logger.log(`Real SMS verification sent via Twilio Verify to ${cleanPhone}`);
            return true;
          }
          const vErr = await vRes.text();
          this.logger.warn(`Twilio Verify API response: ${vErr}; falling back to Messages API`);
        }

        if (!env.TWILIO_FROM_NUMBER) {
          this.logger.error('TWILIO_FROM_NUMBER is missing');
          return false;
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
        const body = new URLSearchParams({
          To: cleanPhone,
          From: env.TWILIO_FROM_NUMBER,
          Body: options.message,
        });

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });

        if (!res.ok) {
          const errText = await res.text();
          this.logger.error(`Twilio SMS failed to ${cleanPhone}: ${errText}`);
          return false;
        }
        this.logger.log(`Real SMS sent via Twilio Messages to ${cleanPhone}`);
        return true;
      } catch (err) {
        this.logger.error(`Error sending Twilio SMS to ${cleanPhone}`, err);
        return false;
      }
    }

    if (env.SMS_DRIVER === 'http' && env.SMS_HTTP_URL) {
      try {
        // Generic HTTP SMS Gateway (replaces placeholder tokens in URL)
        const targetUrl = env.SMS_HTTP_URL
          .replace('{to}', encodeURIComponent(cleanPhone))
          .replace('{message}', encodeURIComponent(options.message));

        const res = await fetch(targetUrl);
        this.logger.log(`SMS Gateway HTTP dispatched to ${cleanPhone} (Status: ${res.status})`);
        return res.ok;
      } catch (err) {
        this.logger.error(`Error sending HTTP SMS to ${cleanPhone}`, err);
        return false;
      }
    }

    // Default 'log' driver for local development & demonstration
    this.logger.warn(`[SMS LOG] 📱 Message to ${cleanPhone}: "${options.message}"`);
    return true;
  }
}

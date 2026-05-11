const nodemailer = require("nodemailer");
const { env } = require("../config/env");

let smtpTransporter = null;

function getTransporter() {
  if (env.EMAIL_DRIVER === "log") {
    return null;
  }

  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }

  return smtpTransporter;
}

async function queueEmail({ to, subject, text, html, eventType, metadata = {} }) {
  if (process.env.NODE_ENV === "test") {
    return { id: "test-email-job", name: "send-email", data: { to, subject, text, html, eventType, metadata } };
  }
  const { emailQueue } = require("../config/queues");
  return emailQueue.add("send-email", {
    to,
    subject,
    text,
    html,
    eventType,
    metadata,
  }, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

async function sendEmailNow(jobData) {
  if (env.EMAIL_DRIVER === "log") {
    console.log("[email:log]", {
      to: jobData.to,
      subject: jobData.subject,
      text: jobData.text,
      eventType: jobData.eventType,
    });
    return { logged: true };
  }

  const transporter = getTransporter();
  return transporter.sendMail({
    from: env.EMAIL_FROM,
    to: jobData.to,
    subject: jobData.subject,
    text: jobData.text,
    html: jobData.html,
  });
}

module.exports = { queueEmail, sendEmailNow };

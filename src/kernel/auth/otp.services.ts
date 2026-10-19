import axios from "axios";

const MSG91_BASE_URL = "https://control.msg91.com/api/v5/otp";

export class OtpService {
  private authKey: string;
  private templateId: string;

  constructor() {
    this.authKey = process.env.MSG91_AUTH_KEY!;
    this.templateId = process.env.MSG91_TEMPLATE_ID!;
  }

  private get headers() {
    return {
      authkey: this.authKey,
      "Content-Type": "application/json",
    };
  }

  async sendOtp(mobile: string) {
    const response = await axios.post(
      MSG91_BASE_URL,
      {
        mobile: `91${mobile}`,
        template_id: this.templateId,
        Lang: "en",
        curr: "INR",
        otp_length: 6,
        otp_expiry: 5,
      },
      { headers: this.headers },
    );

    return response.data;
  }

  async verifyOtp(mobile: string, otp: string) {
    const response = await axios.post(
      `${MSG91_BASE_URL}/verify?mobile=91${mobile}&otp=${otp}`,
      {},
      { headers: this.headers },
    );

    return response.data;
  }

  async resendOtp(mobile: string) {
    const response = await axios.post(
      `${MSG91_BASE_URL}/retry?mobile=91${mobile}&retrytype=text`,
      {},
      { headers: this.headers },
    );

    return response.data;
  }
}

import * as vscode from "vscode";
import type { SecretStorage } from "vscode";
import { parse } from "node-html-parser";
import { CookieJar } from 'tough-cookie';
import { CookieAgent } from 'http-cookie-agent/undici';
import { fetch } from "undici";
import { Script } from "vm";

const jar = new CookieJar();
const agent = new CookieAgent({ cookies: { jar } });

let enableYakin = false;

const getMetaValue = async (htmlString: string, tagName: string) => {
  const html = await parse(htmlString);
  const htmlElement = html.querySelectorAll("meta").find((val) => {
    return val.attributes.name === tagName;
  });
  return htmlElement?.attributes.content || "";
};

const getPageTitle = async (htmlString: string) => {
  const html = await parse(htmlString);
  return html.querySelectorAll("title")[0]?.text || "";
};

const getNameValue = async (htmlString: string, inputName: string) => {
  const html = await parse(htmlString);
  return html.querySelector(`input[name='${inputName}']`)?.attributes["value"] || "";
};

const getCurrentStatus = async () => {
  const context = {} as {
    defaultAditGroupId: number,
    current_status: JobcanStatus
  };

  await fetch("https://ssl.jobcan.jp/employee", {
    method: "GET",
    dispatcher: agent,
  })
  .then(async (res) => {
    const html = await parse(await res.text());
    const status = html.querySelectorAll("script")[14];
    const statusScript = new Script(status.text);
    statusScript.runInNewContext(context);

  })
  .catch(async (err) => {
    vscode.window.showErrorMessage(err);
  });
  return {
    defaultAditGroupId: context.defaultAditGroupId,
    current_status: context.current_status,
  };
};

type JobcanStatus = "resting" | "working" | "having_breakfast";

type JobcanAditResponse = {
  result: number
  state: number
  current_status: JobcanStatus
};

export function activate(context: vscode.ExtensionContext) {
  const secretStorage: SecretStorage = context.secrets;

  let jobcanTouch = vscode.commands.registerCommand(
    "jobcan-code.jobcan-touch",
    async () => {
      if (!(await _jobcanLogin())) {
        vscode.window.showErrorMessage("Login Failed...");
      }

      const formData = new FormData();
      formData.append("is_yakin", enableYakin ? 1 : 0);
      formData.append("adit_item", "DEF");
      formData.append("notice", "");
      formData.append("token", await secretStorage.get("jobcan-adit-token"));
      formData.append("adit_group_id", (await getCurrentStatus()).defaultAditGroupId);

      await fetch("https://ssl.jobcan.jp/employee/index/adit", {
        method: "POST",
        body: formData,
        dispatcher: agent
      })
      .then(async (res) => {
        const jobcanResponse = await res.json() as JobcanAditResponse;
        if (jobcanResponse.result !== 1) {
          throw new Error("It seems wrong. Please check jobcan.");
        }
        vscode.window.showInformationMessage(`Your current status is ${jobcanResponse.current_status}`);
      })
      .catch(async (err) => {
          vscode.window.showErrorMessage(err);
      });
    }
  );

  const fetchCSRF = async () => {
    await fetch("https://id.jobcan.jp/users/sign_in", { dispatcher: agent })
      .then(async (res) => {
        const htmlString = await res.text();
        let csrfToken = await getMetaValue(htmlString, "csrf-token");
        await secretStorage.store("jobcan-csrf-token", csrfToken);
      })
      .catch(async (e: Error) => {
        await vscode.window.showErrorMessage(e.message);
      });
  };

  const fetchADIT = async () => {
    await fetch("https://ssl.jobcan.jp/employee", { dispatcher: agent })
      .then(async (res) => {
        const htmlString = await res.text();
        let aditToken = await getNameValue(htmlString, "token");
        await secretStorage.store("jobcan-adit-token", aditToken);
      })
      .catch(async (e: Error) => {
        await vscode.window.showErrorMessage(e.message);
      });
  };

  const isSetCredentials = async () => {
    const username = await secretStorage.get("jobcan-username");
    const password = await secretStorage.get("jobcan-password");
    if (!username || !password) {

      return false;
    }
    return true;
  };

  const _jobcanLogin = async () => {
    await fetchCSRF().then(async () => {
      if (!await isSetCredentials()) {
        vscode.window.showErrorMessage(
          "ユーザー名もしくはパスワードが設定されていません。"
        );
        return false;
      }

      const formData = new FormData();
      formData.append(
        "authenticity_token",
        await secretStorage.get("jobcan-csrf-token")
      );
      formData.append("user[email]", await secretStorage.get("jobcan-username"));
      formData.append("user[client_code]", "");
      formData.append("user[password]", await secretStorage.get("jobcan-password"));
      formData.append("save_sign_in_information", "true");
      formData.append("app_key", "atd");
      formData.append("commit", "ログイン");

      await fetch("https://id.jobcan.jp/users/sign_in", {
        method: "POST",
        body: formData,
        dispatcher: agent,
      })
        .then(async (res) => {
          const resText = await res.text();
          let csrfToken = await getMetaValue(resText, "csrf-token");
          await secretStorage.store("jobcan-csrf-token", csrfToken);
          return (await getPageTitle(resText)).startsWith("JOBCAN MyPage:");
        })
        .then(async (isLoggedIn) => {
          if (isLoggedIn) {
            await fetchADIT();
            await getCurrentStatus();
            return;
          }
          await vscode.window.showInformationMessage(
            "Login Failed. Check your username or password."
          );
          // TODO: 2FA
        })
        .catch(async (e: Error) => {
          await vscode.window.showErrorMessage(e.message);
          return false;
        });
    });
    return true;
  };

  let jobcanLogin = vscode.commands.registerCommand(
    "jobcan-code.jobcan-login",
    async () => {
      await _jobcanLogin().then(async () => await vscode.window.showInformationMessage("Logged In!"));
    }
  );

  const setUsername = vscode.commands.registerCommand(
    "jobcan-code.jobcan-set-username",
    async () => {
      const username = await vscode.window.showInputBox({
        title: "メールアドレスまたはスタッフコードを入力してください",
        placeHolder: "test@example.net",
      });
      await secretStorage.store("jobcan-username", username || "");
      await vscode.window.showInformationMessage("Set jobcan's username!");
    }
  );

  const setPassword = vscode.commands.registerCommand(
    "jobcan-code.jobcan-set-password",
    async () => {
      const password = await vscode.window.showInputBox({
        title: "パスワードを入力してください",
        password: true,
      });
      await secretStorage.store("jobcan-password", password || "");
      await vscode.window.showInformationMessage("Set jobcan's password!");
    }
  );

  context.subscriptions.push(
    jobcanTouch,
    jobcanLogin,
    setPassword,
    setUsername,
  );
}

// This method is called when your extension is deactivated
export function deactivate(context: vscode.ExtensionContext) {}

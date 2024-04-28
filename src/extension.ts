import * as vscode from "vscode";
import type { SecretStorage } from "vscode";
import { parse } from "node-html-parser";
import { CookieJar } from 'tough-cookie';
import { CookieAgent } from 'http-cookie-agent/undici';
import { fetch } from "undici";

const jar = new CookieJar();
const agent = new CookieAgent({ cookies: { jar } });

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

export function activate(context: vscode.ExtensionContext) {
  const secretStorage: SecretStorage = context.secrets;

  let jobcanTouch = vscode.commands.registerCommand(
    "jobcan-code.jobcan-touch",
    () => {
      vscode.window.showInformationMessage("Hello World from jobcan-code! (Not implemented)");
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

  let jobcanLogin = vscode.commands.registerCommand(
    "jobcan-code.jobcan-login",
    async () => {
			const username = await secretStorage.get("jobcan-username");
			const password = await secretStorage.get("jobcan-password");
			if (!username || !password) {
				vscode.window.showErrorMessage("ユーザー名もしくはパスワードが設定されていません。");
				return;
			}
      await fetchCSRF().then(async () => {

			const formData = new FormData();
			formData.append("authenticity_token", await secretStorage.get("jobcan-csrf-token"));
			formData.append("user[email]", await secretStorage.get("jobcan-username"));
			formData.append("user[client_code]", "");
			formData.append("user[password]", await secretStorage.get("jobcan-password"));
			formData.append("save_sign_in_information", "true");
			formData.append("app_key", "atd");
			formData.append("commit", "ログイン");

      await fetch("https://id.jobcan.jp/users/sign_in", {
        method: "POST",
        body: formData,
        dispatcher: agent
      })
			.then(async (res) => {
				const resText = await res.text();
        let csrfToken = await getMetaValue(resText, "csrf-token");
        await secretStorage.store("jobcan-csrf-token", csrfToken);
        return (await getPageTitle(resText)).startsWith("JOBCAN MyPage:");
			})
			.then(async (isLoggedIn) => {
				if (isLoggedIn) {
          await vscode.window.showInformationMessage("Logged In!");
          await fetchADIT();
					return;
				}
        await vscode.window.showInformationMessage("Login Failed. Check your username or password.");
        // TODO: 2FA
			})
			.catch(async (e: Error) => {
				await vscode.window.showErrorMessage(e.message);
			});

			});
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

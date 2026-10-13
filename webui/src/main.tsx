import { Provider, ToastContainer, defaultTheme } from "@adobe/react-spectrum";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppShell, RouteError } from "./app";
import { Dashboard } from "./dashboard";
import "./styles.css";
import fontTheme from "./theme.module.css";

const theme = {
  ...defaultTheme,
  global: {
    ...defaultTheme.global,
    ...fontTheme,
  },
};

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: <Dashboard />,
      },
      {
        path: "*",
        element: <Navigate to="/" replace />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <Provider theme={theme} colorScheme="light" locale="zh-CN">
    <RouterProvider router={router} />
    <ToastContainer placement="bottom end" />
  </Provider>,
);

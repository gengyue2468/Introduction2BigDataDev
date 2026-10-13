import {
  Button,
  Flex,
  Heading,
  Text,
  View,
} from "@adobe/react-spectrum";
import {
  Outlet,
  useNavigate,
  useRouteError,
} from "react-router";
import {
  ApiError,
} from "./api";

export function AppShell() {
  return (
    <View elementType="main" minHeight="100vh" padding={{ base: "size-200", L: "size-400" }}>
      <View width="100%" maxWidth="80rem" marginX="auto">
        <Outlet />
      </View>
    </View>
  );
}

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  let message = "页面加载失败";

  if (error instanceof ApiError) {
    message = error.message;
  } else if (error instanceof Response) {
    message = error.statusText || `请求失败（${error.status}）`;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <Flex direction="column" gap="size-200" maxWidth="size-4600">
      <Heading level={1}>页面加载失败</Heading>
      <Text>{message}</Text>
      <Button variant="primary" style="fill" staticColor="black" onPress={() => navigate("/")}>
        返回
      </Button>
    </Flex>
  );
}

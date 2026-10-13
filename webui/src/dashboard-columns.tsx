import { Grid, View } from "@adobe/react-spectrum";
import type { ReactNode } from "react";

export function DashboardColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <Grid
      columns={{ base: ["minmax(0, 1fr)"], L: ["minmax(0, 24rem)", "minmax(0, 1fr)"] }}
      gap={{ base: "size-400", L: "size-600" }}
      alignItems="start"
      width="100%"
    >
      <View minWidth="0px">{left}</View>
      <View minWidth="0px">{right}</View>
    </Grid>
  );
}

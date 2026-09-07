from receive_message import initialise_message_table, receive_message
from process_message import initialise_processed_table, process_latest_message
from export_updates import export_csv, export_excel, get_update_rows, build_report_rows
from dashboard import create_dashboard


def run_pipeline():
    """Run the complete local stand-up workflow."""

    print("--- LOCAL END-TO-END PIPELINE ---")

    initialise_message_table()
    initialise_processed_table()

    print("\nStep 1: Receive message")
    receive_message()

    print("\nStep 2: Process latest message")
    process_latest_message()

    print("\nStep 3: Export reports")
    database_rows = get_update_rows()
    report_rows = build_report_rows(database_rows)
    export_csv(report_rows)
    export_excel(report_rows)
    print("CSV and Excel reports updated.")

    print("\nStep 4: Refresh dashboard")
    create_dashboard()

    print("\nLocal pipeline completed successfully.")


if __name__ == "__main__":
    run_pipeline()